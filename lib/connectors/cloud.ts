import crypto from "crypto";
import { ConnectorDocument, ConnectorPayload, parseCsv, safeFetch, sanitizeConnectorSourceName } from "./types";

const TEXT_EXTENSIONS = /\.(txt|md|mdx|csv|json|ts|tsx|js|jsx|py|sql|yml|yaml|xml|log)$/i;

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function buildAwsHeaders(
  method: string,
  urlStr: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string
): Record<string, string> {
  const parsed = new URL(urlStr);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");

  const canonicalHeaders = `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalQuery = Array.from(parsed.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function fetchS3Connector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const bucket = input.bucket?.trim();
  const region = input.region?.trim() || process.env.AWS_REGION || "us-east-1";
  const accessKeyId = input.accessKeyId?.trim() || process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = input.secretAccessKey?.trim() || process.env.AWS_SECRET_ACCESS_KEY || "";
  const endpointBase = (input.endpoint?.trim() || `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, "");

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 bucket, Access Key ID, and Secret Access Key are required");
  }

  const listUrl = new URL(`${endpointBase}/`);
  listUrl.searchParams.set("list-type", "2");
  listUrl.searchParams.set("max-keys", "25");
  if (input.prefix?.trim()) listUrl.searchParams.set("prefix", input.prefix.trim());

  const listRes = await safeFetch(listUrl.toString(), {
    headers: buildAwsHeaders("GET", listUrl.toString(), region, accessKeyId, secretAccessKey),
  });
  if (!listRes.ok) throw new Error(`S3 ListObjectsV2 failed (${listRes.status})`);

  const xml = await listRes.text();
  const keys = Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g))
    .map(m => m[1])
    .filter(k => TEXT_EXTENSIONS.test(k))
    .slice(0, 20);

  const docs: ConnectorDocument[] = [];
  for (const key of keys) {
    const encodedPath = key.split("/").map(encodeURIComponent).join("/");
    const objUrl = `${endpointBase}/${encodedPath}`;
    const objRes = await safeFetch(objUrl, {
      headers: buildAwsHeaders("GET", objUrl, region, accessKeyId, secretAccessKey),
    });
    if (!objRes.ok) continue;
    const raw = await objRes.text();
    const content = key.toLowerCase().endsWith(".csv") ? parseCsv(raw) : raw;
    if (!content.trim()) continue;

    docs.push({
      sourceName: sanitizeConnectorSourceName(`s3_${bucket}_${key}`),
      content: `# s3://${bucket}/${key}\n\n${content.slice(0, 60000)}`,
      metadata: { source: `s3://${bucket}/${key}`, section: key, page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No readable text objects found in S3 bucket");
  return docs;
}

export async function fetchGoogleDriveConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";
  if (!token) throw new Error("Google Drive OAuth Access Token is required");

  const headers = { Authorization: `Bearer ${token}` };
  const queryParts = ["trashed = false"];
  if (input.folderId?.trim()) {
    queryParts.push(`'${input.folderId.trim().replace(/'/g, "")}' in parents`);
  }
  const q = encodeURIComponent(queryParts.join(" and "));
  const listRes = await safeFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=20&fields=files(id,name,mimeType)`,
    { headers }
  );
  if (!listRes.ok) throw new Error(`Google Drive API failed (${listRes.status})`);

  const data = await listRes.json();
  const files = Array.isArray(data?.files) ? data.files : [];
  const docs: ConnectorDocument[] = [];

  for (const f of files) {
    let text = "";
    if (f.mimeType === "application/vnd.google-apps.document") {
      const expRes = await safeFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}/export?mimeType=text/plain`,
        { headers }
      );
      if (expRes.ok) text = await expRes.text();
    } else if (f.mimeType?.startsWith("text/") || f.mimeType === "application/json") {
      const dlRes = await safeFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`,
        { headers }
      );
      if (dlRes.ok) text = await dlRes.text();
    }

    if (!text.trim()) continue;
    docs.push({
      sourceName: sanitizeConnectorSourceName(`gdrive_${f.name}`),
      content: `# ${f.name}\n\n${text.slice(0, 60000)}`,
      metadata: { source: `gdrive://${f.id}`, section: f.name, page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No supported text/Google Docs files found in Drive");
  return docs;
}

export async function fetchSharePointConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.MS_GRAPH_ACCESS_TOKEN || "";
  if (!token) throw new Error("Microsoft Graph Access Token is required");

  const headers = { Authorization: `Bearer ${token}` };
  let listEndpoint = "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=25";
  if (input.siteId?.trim()) {
    listEndpoint = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(input.siteId.trim())}/drive/root/children?$top=25`;
  } else if (input.driveId?.trim()) {
    listEndpoint = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(input.driveId.trim())}/root/children?$top=25`;
  }

  const res = await safeFetch(listEndpoint, { headers });
  if (!res.ok) throw new Error(`Microsoft Graph API failed (${res.status})`);

  const data = await res.json();
  const items = (Array.isArray(data?.value) ? data.value : []).filter(
    (item: any) => item?.file && typeof item.name === "string" && TEXT_EXTENSIONS.test(item.name)
  );

  const docs: ConnectorDocument[] = [];
  for (const item of items.slice(0, 15)) {
    const dlUrl = item["@microsoft.graph.downloadUrl"];
    if (!dlUrl) continue;
    const dlRes = await safeFetch(dlUrl);
    if (!dlRes.ok) continue;
    const text = await dlRes.text();
    if (!text.trim()) continue;

    docs.push({
      sourceName: sanitizeConnectorSourceName(`sharepoint_${item.name}`),
      content: `# ${item.name}\n\n${text.slice(0, 60000)}`,
      metadata: { source: item.webUrl || item.id, section: item.name, page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No supported text files found in SharePoint / OneDrive");
  return docs;
}
