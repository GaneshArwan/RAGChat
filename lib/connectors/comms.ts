import { ConnectorDocument, ConnectorPayload, htmlToText, safeFetch, sanitizeConnectorSourceName } from "./types";

export async function fetchMsTeamsConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.MS_GRAPH_ACCESS_TOKEN || "";
  const teamId = input.teamId?.trim();
  const channelId = input.channelId?.trim();
  if (!token || !teamId || !channelId) {
    throw new Error("Microsoft Graph Token, Team ID, and Channel ID are required");
  }

  const res = await safeFetch(
    `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Microsoft Teams API failed (${res.status})`);
  const data = await res.json();
  const msgs = Array.isArray(data?.value) ? data.value : [];
  const lines = msgs
    .map((m: any) => {
      const body = htmlToText(m?.body?.content || "");
      const author = m?.from?.user?.displayName || m?.from?.application?.displayName || "Member";
      return body ? `[${m.createdDateTime || ""}] ${author}: ${body}` : "";
    })
    .filter(Boolean);

  if (lines.length === 0) throw new Error("No messages found in Microsoft Teams channel");
  return [{
    sourceName: sanitizeConnectorSourceName(`msteams_${teamId}_${channelId}.txt`),
    content: `# MS Teams Channel ${channelId}\n\n${lines.join("\n")}`,
    metadata: { source: `msteams://${teamId}/${channelId}`, section: "Teams Channel", page: 1 },
  }];
}

export async function fetchDiscordConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.DISCORD_BOT_TOKEN || "";
  const channelId = input.channelId?.trim();
  if (!token || !channelId) throw new Error("Discord Bot Token and Channel ID are required");

  const res = await safeFetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=100`,
    { headers: { Authorization: `Bot ${token}` } }
  );
  if (!res.ok) throw new Error(`Discord API failed (${res.status})`);
  const msgs = await res.json();
  if (!Array.isArray(msgs) || msgs.length === 0) throw new Error("No messages found in Discord channel");

  const lines = msgs
    .slice()
    .reverse()
    .filter((m: any) => typeof m.content === "string" && m.content.trim())
    .map((m: any) => `[${m.timestamp || ""}] ${m.author?.username || "user"}: ${m.content}`);

  return [{
    sourceName: sanitizeConnectorSourceName(`discord_${channelId}.txt`),
    content: `# Discord Channel ${channelId}\n\n${lines.join("\n")}`,
    metadata: { source: `discord://channels/${channelId}`, section: `Discord ${channelId}`, page: 1 },
  }];
}

export async function fetchMetaGraphConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.META_ACCESS_TOKEN || "";
  const nodeId = input.projectId?.trim() || input.channelId?.trim() || "me";
  if (!token) throw new Error("Meta Graph Access Token is required");

  const res = await safeFetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(nodeId)}/posts?fields=id,message,created_time,permalink_url&limit=25&access_token=${encodeURIComponent(token)}`
  );
  if (!res.ok) throw new Error(`Meta Graph API failed (${res.status})`);
  const data = await res.json();
  const posts = (Array.isArray(data?.data) ? data.data : []).filter((p: any) => p?.message);
  if (posts.length === 0) throw new Error("No text posts returned from Meta Graph API");

  const content = posts
    .map((p: any) => `## Post ${p.id} (${p.created_time || ""})\n${p.message}\nURL: ${p.permalink_url || ""}`)
    .join("\n\n");

  return [{
    sourceName: sanitizeConnectorSourceName(`meta_${nodeId}_posts.md`),
    content: `# Meta Graph (${nodeId})\n\n${content}`,
    metadata: { source: `https://graph.facebook.com/${nodeId}`, section: `Meta ${nodeId}`, page: 1 },
  }];
}
