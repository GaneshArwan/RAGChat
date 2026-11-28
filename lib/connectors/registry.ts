import { ConnectorDocument, ConnectorPayload, ConnectorType } from "./types";
import { fetchWebConnector } from "./web";
import { fetchGitHubConnector } from "./github";
import { fetchNotionConnector, fetchConfluenceConnector } from "./wiki";
import { fetchJiraConnector, fetchAsanaConnector, fetchLinearConnector, fetchSlackConnector } from "./work";
import { fetchS3Connector, fetchGoogleDriveConnector, fetchSharePointConnector } from "./cloud";
import { fetchPostgresConnector } from "./database";
import { fetchGmailConnector, fetchGoogleSheetsConnector, fetchBigQueryConnector, fetchGcsConnector } from "./google";
import { fetchMsTeamsConnector, fetchDiscordConnector, fetchMetaGraphConnector } from "./comms";
import { fetchSalesforceConnector, fetchZendeskConnector, fetchHubSpotConnector, fetchSnowflakeConnector, fetchMongoDbConnector } from "./enterprise";
import { fetchMysqlConnector, fetchClickHouseConnector, fetchDatabricksConnector, fetchTursoConnector } from "./sql-databases";
import {
  fetchSupabaseConnector,
  fetchElasticsearchConnector,
  fetchFirestoreConnector,
  fetchDynamoDbConnector,
  fetchAirtableConnector,
  fetchRedisDbConnector,
} from "./nosql-search";
import { fetchGraphqlConnector, fetchRestApiConnector } from "./universal";

export interface ConnectorMeta {
  type: ConnectorType;
  label: string;
  category:
    | "Web & Code"
    | "Wikis"
    | "Work & PM"
    | "Google & Cloud"
    | "CRM & Support"
    | "Databases & Warehouses";
  description: string;
  envConfigured: boolean;
}

export function getConnectorCatalog(): ConnectorMeta[] {
  return [
    { type: "web", label: "Web URL / Sitemap", category: "Web & Code", description: "Crawl docs pages or sitemap.xml", envConfigured: false },
    { type: "github", label: "GitHub Repo", category: "Web & Code", description: "Index repo code, docs, and issues", envConfigured: !!process.env.GITHUB_TOKEN },
    { type: "graphql", label: "GraphQL Endpoint", category: "Web & Code", description: "Query any GraphQL / Hasura API", envConfigured: false },
    { type: "rest_api", label: "Universal REST API", category: "Web & Code", description: "Ingest any JSON / REST endpoint", envConfigured: false },

    { type: "notion", label: "Notion", category: "Wikis", description: "Sync Notion workspace pages", envConfigured: !!process.env.NOTION_API_KEY },
    { type: "confluence", label: "Confluence", category: "Wikis", description: "Sync Confluence spaces via CQL", envConfigured: !!process.env.CONFLUENCE_API_TOKEN },

    { type: "jira", label: "Jira", category: "Work & PM", description: "Index Jira issues & comments via JQL", envConfigured: !!process.env.JIRA_API_TOKEN },
    { type: "asana", label: "Asana", category: "Work & PM", description: "Index Asana project tasks & notes", envConfigured: !!process.env.ASANA_ACCESS_TOKEN },
    { type: "linear", label: "Linear", category: "Work & PM", description: "Index Linear issues & comments", envConfigured: !!process.env.LINEAR_API_KEY },
    { type: "slack", label: "Slack", category: "Work & PM", description: "Index Slack channel history", envConfigured: !!process.env.SLACK_BOT_TOKEN },
    { type: "msteams", label: "Microsoft Teams", category: "Work & PM", description: "Sync Teams channel messages", envConfigured: !!process.env.MS_GRAPH_ACCESS_TOKEN },
    { type: "discord", label: "Discord", category: "Work & PM", description: "Sync Discord channel messages", envConfigured: !!process.env.DISCORD_BOT_TOKEN },
    { type: "meta", label: "Meta Graph", category: "Work & PM", description: "Index Meta Page posts & feeds", envConfigured: !!process.env.META_ACCESS_TOKEN },

    { type: "gmail", label: "Gmail", category: "Google & Cloud", description: "Sync Gmail threads by query", envConfigured: !!process.env.GMAIL_ACCESS_TOKEN },
    { type: "gsheets", label: "Google Sheets", category: "Google & Cloud", description: "Parse Sheets ranges as structured tables", envConfigured: !!process.env.GOOGLE_SHEETS_ACCESS_TOKEN },
    { type: "gdrive", label: "Google Drive", category: "Google & Cloud", description: "Export Google Docs & text files", envConfigured: !!process.env.GOOGLE_DRIVE_ACCESS_TOKEN },
    { type: "gcs", label: "Google Cloud Storage", category: "Google & Cloud", description: "Ingest objects from GCS buckets", envConfigured: !!process.env.GCS_ACCESS_TOKEN },
    { type: "s3", label: "Amazon S3 / MinIO", category: "Google & Cloud", description: "Ingest objects from S3 buckets", envConfigured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) },
    { type: "sharepoint", label: "SharePoint / OneDrive", category: "Google & Cloud", description: "Sync Microsoft Graph drive files", envConfigured: !!process.env.MS_GRAPH_ACCESS_TOKEN },

    { type: "salesforce", label: "Salesforce CRM", category: "CRM & Support", description: "Query CRM objects via SOQL", envConfigured: !!process.env.SALESFORCE_ACCESS_TOKEN },
    { type: "zendesk", label: "Zendesk", category: "CRM & Support", description: "Sync Help Center articles & tickets", envConfigured: !!process.env.ZENDESK_API_TOKEN },
    { type: "hubspot", label: "HubSpot CRM", category: "CRM & Support", description: "Sync deals, contacts & tickets", envConfigured: !!process.env.HUBSPOT_ACCESS_TOKEN },
    { type: "airtable", label: "Airtable", category: "CRM & Support", description: "Sync Airtable bases & tables", envConfigured: !!process.env.AIRTABLE_API_TOKEN },

    { type: "postgres", label: "PostgreSQL (Read-Only)", category: "Databases & Warehouses", description: "Query Postgres schemas/tables safely", envConfigured: !!process.env.POSTGRES_URL },
    { type: "mysql", label: "MySQL / MariaDB", category: "Databases & Warehouses", description: "Read-only MySQL tables or SELECT SQL", envConfigured: !!process.env.MYSQL_URL },
    { type: "supabase", label: "Supabase DB", category: "Databases & Warehouses", description: "Ingest Supabase tables via PostgREST", envConfigured: !!process.env.SUPABASE_URL },
    { type: "mongodb", label: "MongoDB Atlas", category: "Databases & Warehouses", description: "Query collections via Atlas Data API", envConfigured: !!process.env.MONGODB_DATA_API_KEY },
    { type: "firestore", label: "Firebase Firestore", category: "Databases & Warehouses", description: "Read Firestore collections via REST", envConfigured: !!process.env.FIRESTORE_ACCESS_TOKEN },
    { type: "dynamodb", label: "Amazon DynamoDB", category: "Databases & Warehouses", description: "Scan DynamoDB tables via AWS SigV4", envConfigured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) },
    { type: "redis_db", label: "Redis Data Store", category: "Databases & Warehouses", description: "Scan Redis keys/hashes safely", envConfigured: !!process.env.REDIS_DATA_URL },
    { type: "elasticsearch", label: "Elasticsearch / OpenSearch", category: "Databases & Warehouses", description: "Search & sync index documents", envConfigured: !!process.env.ELASTICSEARCH_URL },
    { type: "clickhouse", label: "ClickHouse", category: "Databases & Warehouses", description: "Run read-only ClickHouse OLAP SQL", envConfigured: !!process.env.CLICKHOUSE_URL },
    { type: "bigquery", label: "Google BigQuery", category: "Databases & Warehouses", description: "Run read-only analytical SELECT SQL", envConfigured: !!process.env.BIGQUERY_ACCESS_TOKEN },
    { type: "snowflake", label: "Snowflake SQL", category: "Databases & Warehouses", description: "Run read-only Snowflake SQL v2", envConfigured: !!process.env.SNOWFLAKE_TOKEN },
    { type: "databricks", label: "Databricks SQL", category: "Databases & Warehouses", description: "Query Databricks SQL Warehouses", envConfigured: !!process.env.DATABRICKS_TOKEN },
    { type: "turso", label: "Turso / LibSQL", category: "Databases & Warehouses", description: "Query edge SQLite via LibSQL HTTP", envConfigured: !!process.env.TURSO_AUTH_TOKEN },
  ];
}

export async function runConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  switch (input.type) {
    case "web":
      return await fetchWebConnector(input);
    case "github":
      return await fetchGitHubConnector(input);
    case "graphql":
      return await fetchGraphqlConnector(input);
    case "rest_api":
      return await fetchRestApiConnector(input);
    case "notion":
      return await fetchNotionConnector(input);
    case "confluence":
      return await fetchConfluenceConnector(input);
    case "jira":
      return await fetchJiraConnector(input);
    case "asana":
      return await fetchAsanaConnector(input);
    case "linear":
      return await fetchLinearConnector(input);
    case "slack":
      return await fetchSlackConnector(input);
    case "s3":
      return await fetchS3Connector(input);
    case "gdrive":
      return await fetchGoogleDriveConnector(input);
    case "sharepoint":
      return await fetchSharePointConnector(input);
    case "postgres":
      return await fetchPostgresConnector(input);
    case "gmail":
      return await fetchGmailConnector(input);
    case "gsheets":
      return await fetchGoogleSheetsConnector(input);
    case "bigquery":
      return await fetchBigQueryConnector(input);
    case "gcs":
      return await fetchGcsConnector(input);
    case "msteams":
      return await fetchMsTeamsConnector(input);
    case "discord":
      return await fetchDiscordConnector(input);
    case "meta":
      return await fetchMetaGraphConnector(input);
    case "salesforce":
      return await fetchSalesforceConnector(input);
    case "zendesk":
      return await fetchZendeskConnector(input);
    case "hubspot":
      return await fetchHubSpotConnector(input);
    case "snowflake":
      return await fetchSnowflakeConnector(input);
    case "mongodb":
      return await fetchMongoDbConnector(input);
    case "mysql":
      return await fetchMysqlConnector(input);
    case "supabase":
      return await fetchSupabaseConnector(input);
    case "clickhouse":
      return await fetchClickHouseConnector(input);
    case "databricks":
      return await fetchDatabricksConnector(input);
    case "elasticsearch":
      return await fetchElasticsearchConnector(input);
    case "firestore":
      return await fetchFirestoreConnector(input);
    case "turso":
      return await fetchTursoConnector(input);
    case "airtable":
      return await fetchAirtableConnector(input);
    case "redis_db":
      return await fetchRedisDbConnector(input);
    case "dynamodb":
      return await fetchDynamoDbConnector(input);
    default:
      throw new Error(`Unsupported connector type: ${(input as any).type}`);
  }
}
