import { ConnectorDocument, ConnectorPayload, safeFetch, sanitizeConnectorSourceName } from "./types";

function extractAdfText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

export async function fetchJiraConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  const email = input.email?.trim() || process.env.JIRA_EMAIL || "";
  const token = input.apiToken?.trim() || process.env.JIRA_API_TOKEN || "";

  if (!baseUrl || !token) {
    throw new Error("Jira Base URL and API Token are required");
  }

  const authHeader = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
    : `Bearer ${token}`;

  const jql = input.jql?.trim() || "ORDER BY updated DESC";
  const headers = { Authorization: authHeader, Accept: "application/json" };
  const fields = "summary,description,status,assignee,priority,updated,comment";

  let res = await safeFetch(
    `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=25&fields=${fields}`,
    { headers }
  );
  if (res.status === 404 || res.status === 410) {
    res = await safeFetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=25&fields=${fields}`,
      { headers }
    );
  }
  if (!res.ok) throw new Error(`Jira API failed (${res.status})`);

  const data = await res.json();
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const docs: ConnectorDocument[] = [];

  for (const issue of issues) {
    const f = issue.fields || {};
    const desc = extractAdfText(f.description);
    const comments = (f.comment?.comments || [])
      .slice(-5)
      .map((c: any) => `- ${c.author?.displayName || "User"}: ${extractAdfText(c.body)}`)
      .join("\n");

    const content = [
      `# ${issue.key}: ${f.summary || "Untitled"}`,
      `Status: ${f.status?.name || "Unknown"} | Priority: ${f.priority?.name || "N/A"} | Assignee: ${f.assignee?.displayName || "Unassigned"}`,
      desc ? `\nDescription:\n${desc}` : "",
      comments ? `\nRecent Comments:\n${comments}` : "",
    ].filter(Boolean).join("\n");

    docs.push({
      sourceName: sanitizeConnectorSourceName(`jira_${issue.key}.md`),
      content,
      metadata: { source: `${baseUrl}/browse/${issue.key}`, section: `${issue.key}: ${f.summary || ""}`.slice(0, 80), page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No Jira issues matched the JQL query");
  return docs;
}

export async function fetchAsanaConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.ASANA_ACCESS_TOKEN || "";
  const projectId = input.projectId?.trim();
  if (!token) throw new Error("Asana Personal Access Token is required");
  if (!projectId) throw new Error("Asana Project ID is required");

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const fields = "name,notes,completed,due_on,assignee.name,memberships.section.name";
  const res = await safeFetch(
    `https://app.asana.com/api/1.0/projects/${encodeURIComponent(projectId)}/tasks?opt_fields=${fields}&limit=50`,
    { headers }
  );
  if (!res.ok) throw new Error(`Asana API failed (${res.status})`);

  const data = await res.json();
  const tasks = Array.isArray(data?.data) ? data.data : [];
  if (tasks.length === 0) throw new Error("No tasks found in Asana project");

  const lines = tasks.map((t: any) => {
    const section = t.memberships?.[0]?.section?.name || "Backlog";
    return [
      `## ${t.name || "Untitled Task"} (${t.completed ? "Completed" : "Open"})`,
      `Section: ${section} | Assignee: ${t.assignee?.name || "Unassigned"} | Due: ${t.due_on || "None"}`,
      t.notes ? t.notes : "",
    ].filter(Boolean).join("\n");
  });

  return [{
    sourceName: sanitizeConnectorSourceName(`asana_project_${projectId}.md`),
    content: `# Asana Project ${projectId}\n\n${lines.join("\n\n")}`,
    metadata: { source: `https://app.asana.com/0/${projectId}`, section: `Asana ${projectId}`, page: 1 },
  }];
}

export async function fetchLinearConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.LINEAR_API_KEY || "";
  if (!token) throw new Error("Linear API Key is required");

  const filterClause = input.teamId?.trim()
    ? `(first: 30, filter: { team: { key: { eq: "${input.teamId.trim().replace(/"/g, "")}" } } })`
    : "(first: 30)";

  const query = `query { issues${filterClause} { nodes { identifier title description priorityLabel state { name } assignee { name } url comments(last: 5) { nodes { body user { name } } } } } }`;

  const res = await safeFetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Linear API failed (${res.status})`);

  const data = await res.json();
  const nodes = data?.data?.issues?.nodes || [];
  if (nodes.length === 0) throw new Error("No Linear issues found");

  return nodes.map((iss: any) => {
    const comments = (iss.comments?.nodes || [])
      .map((c: any) => `- ${c.user?.name || "Member"}: ${c.body || ""}`)
      .join("\n");
    return {
      sourceName: sanitizeConnectorSourceName(`linear_${iss.identifier}.md`),
      content: [
        `# ${iss.identifier}: ${iss.title}`,
        `State: ${iss.state?.name || "Unknown"} | Priority: ${iss.priorityLabel || "None"} | Assignee: ${iss.assignee?.name || "Unassigned"}`,
        iss.description ? `\n${iss.description}` : "",
        comments ? `\nComments:\n${comments}` : "",
      ].filter(Boolean).join("\n"),
      metadata: { source: iss.url || iss.identifier, section: `${iss.identifier}: ${iss.title}`.slice(0, 80), page: 1 },
    };
  });
}

export async function fetchSlackConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.SLACK_BOT_TOKEN || "";
  const channelId = input.channelId?.trim();
  if (!token) throw new Error("Slack Bot Token is required");
  if (!channelId) throw new Error("Slack Channel ID is required");

  const res = await safeFetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Slack API failed (${res.status})`);

  const data = await res.json();
  if (!data?.ok) throw new Error(`Slack error: ${data?.error || "Unknown error"}`);

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  if (messages.length === 0) throw new Error("No messages found in Slack channel");

  const formatted = messages
    .slice()
    .reverse()
    .filter((m: any) => typeof m.text === "string" && m.text.trim())
    .map((m: any) => {
      const ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : "";
      return `[${ts}] ${m.user || m.bot_id || "user"}: ${m.text}`;
    })
    .join("\n");

  return [{
    sourceName: sanitizeConnectorSourceName(`slack_${channelId}.txt`),
    content: `# Slack Channel ${channelId}\n\n${formatted}`,
    metadata: { source: `slack://channel/${channelId}`, section: `Slack ${channelId}`, page: 1 },
  }];
}
