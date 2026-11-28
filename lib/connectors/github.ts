import { ConnectorDocument, ConnectorPayload, safeFetch, sanitizeConnectorSourceName } from "./types";

const TEXT_FILE_EXTS = /\.(md|mdx|txt|ts|tsx|js|jsx|py|go|rs|java|rb|sql|yml|yaml|json|toml|sh|env\.example)$/i;

export async function fetchGitHubConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const repo = input.repo?.trim();
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("GitHub repository must be in owner/repo format");
  }
  const branch = input.branch?.trim() || "main";
  const prefix = (input.pathPrefix || "").replace(/^\/+/, "");
  const token = input.apiToken?.trim() || process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RAGChat-Enterprise/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const treeRes = await safeFetch(treeUrl, { headers });
  if (!treeRes.ok) {
    throw new Error(`GitHub tree fetch failed (${treeRes.status}). Check repo/branch or token.`);
  }
  const treeData = await treeRes.json();
  const candidates = (Array.isArray(treeData?.tree) ? treeData.tree : [])
    .filter((item: any) =>
      item?.type === "blob" &&
      typeof item?.path === "string" &&
      TEXT_FILE_EXTS.test(item.path) &&
      (!prefix || item.path.startsWith(prefix)) &&
      (item.size || 0) <= 200_000
    )
    .slice(0, 20);

  const docs: ConnectorDocument[] = [];
  for (const item of candidates) {
    const fileUrl = `https://api.github.com/repos/${repo}/contents/${item.path}?ref=${encodeURIComponent(branch)}`;
    const fileRes = await safeFetch(fileUrl, { headers });
    if (!fileRes.ok) continue;
    const fileJson = await fileRes.json();
    if (!fileJson?.content) continue;
    const decoded = Buffer.from(fileJson.content, "base64").toString("utf-8").trim();
    if (!decoded) continue;

    docs.push({
      sourceName: sanitizeConnectorSourceName(`github_${repo}_${item.path}`),
      content: `# ${repo}/${item.path}\nBranch: ${branch}\n\n${decoded}`,
      metadata: { source: `https://github.com/${repo}/blob/${branch}/${item.path}`, section: item.path, page: 1 },
    });
  }

  if (input.includeIssues) {
    const issuesRes = await safeFetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=15`, { headers });
    if (issuesRes.ok) {
      const issues = await issuesRes.json();
      if (Array.isArray(issues) && issues.length > 0) {
        const summary = issues
          .map((iss: any) => `## Issue #${iss.number}: ${iss.title}\nState: ${iss.state}\n${(iss.body || "").slice(0, 1500)}`)
          .join("\n\n");
        docs.push({
          sourceName: sanitizeConnectorSourceName(`github_${repo}_issues.md`),
          content: summary,
          metadata: { source: `https://github.com/${repo}/issues`, section: "Open Issues", page: 1 },
        });
      }
    }
  }

  if (docs.length === 0) {
    throw new Error("No matching text/code files found in GitHub repository");
  }
  return docs;
}
