"use client";

import { useState, useEffect } from "react";
import { X, ShieldCheck, Copy, RefreshCw, Activity, Play, FlaskConical, Terminal, Search } from "lucide-react";
import { AppConfig } from "@/lib/config";
import type { ConnectorType } from "@/lib/connectors/types";

interface ConnectorMeta {
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

interface ConnectorsHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  isConfigComplete: boolean;
  onSyncSuccess: (files: string[], message: string) => void;
  onNotify: (message: string, type: "error" | "success" | "info") => void;
}

const CATEGORIES: Array<"All" | ConnectorMeta["category"]> = [
  "All",
  "Web & Code",
  "Wikis",
  "Work & PM",
  "Google & Cloud",
  "CRM & Support",
  "Databases & Warehouses",
];

export function ConnectorsHubModal({
  isOpen,
  onClose,
  config,
  isConfigComplete,
  onSyncSuccess,
  onNotify,
}: ConnectorsHubModalProps) {
  const [catalog, setCatalog] = useState<ConnectorMeta[]>([]);
  const [category, setCategory] = useState<"All" | ConnectorMeta["category"]>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<ConnectorType>("postgres");
  const [allowedRoles, setAllowedRoles] = useState((config.userRoles || ["member"]).join(", "));
  const [runAsync, setRunAsync] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [form, setForm] = useState<Record<string, any>>({
    url: "",
    maxPages: 5,
    repo: "",
    branch: "main",
    pathPrefix: "",
    includeIssues: false,
    apiToken: "",
    email: "",
    baseUrl: "",
    query: "",
    spaceKey: "",
    jql: "ORDER BY updated DESC",
    projectId: "",
    teamId: "",
    channelId: "",
    bucket: "",
    prefix: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    endpoint: "",
    folderId: "",
    siteId: "",
    driveId: "",
    connectionString: "",
    sqlQuery: "",
    maxRows: 100,
    warehouseId: "",
    tableName: "",
    indexName: "",
    keyPattern: "*",
    authHeaderName: "Authorization",
  });

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/connectors")
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.connectors)) setCatalog(data.connectors);
      })
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const q = searchQuery.trim().toLowerCase();
  const filtered = catalog.filter(c => {
    const catMatch = category === "All" || c.category === category;
    const textMatch = !q || c.label.toLowerCase().includes(q) || c.type.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
    return catMatch && textMatch;
  });
  const currentMeta = catalog.find(c => c.type === selected);

  const handleCategoryChange = (cat: "All" | ConnectorMeta["category"]) => {
    setCategory(cat);
    const first = cat === "All" ? catalog[0] : catalog.find(c => c.category === cat);
    if (first) setSelected(first.type);
  };

  const handleSync = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConfigComplete) {
      onNotify("Complete System Configuration (LLM + Embeddings) before syncing connectors.", "error");
      return;
    }

    setSyncing(true);
    try {
      const roles = allowedRoles.split(",").map(r => r.trim()).filter(Boolean);
      const connectorPayload: Record<string, any> = { type: selected };
      for (const [k, v] of Object.entries(form)) {
        if (v !== "" && v !== undefined && v !== null) {
          connectorPayload[k] = v;
        }
      }

      const endpoint = runAsync ? "/api/jobs" : "/api/connectors";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connector: connectorPayload,
          config,
          allowedRoles: roles.length > 0 ? roles : ["member"],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || "Connector sync failed", "error");
        return;
      }

      if (runAsync) {
        onNotify(`Async ingestion job queued (${data.jobId}). Check Audit / API -> Audit & Jobs for progress.`, "info");
        onClose();
        return;
      }

      onSyncSuccess(data.indexedFiles || [], data.message || "Connector synced");
      onClose();
    } catch (err: any) {
      onNotify(err?.message || "Connector sync failed", "error");
    } finally {
      setSyncing(false);
    }
  };

  const inputCls =
    "w-full bg-slate-50 dark:bg-emerald-900/40 border border-slate-300 dark:border-emerald-500/25 rounded-xl p-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600";
  const labelCls = "text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-emerald-300/80";

  return (
    <div role="dialog" aria-modal="true" aria-label="Universal Data and Database Hub" className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-white dark:bg-[#06151c] border border-slate-200 dark:border-emerald-500/25 rounded-2xl shadow-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 dark:border-emerald-500/15 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold tracking-tight text-slate-900 dark:text-emerald-50">Universal Data &amp; DB Hub ({catalog.length || 36})</h3>
            <p className="text-[11px] font-semibold text-slate-600 dark:text-emerald-300/75">SQL, NoSQL, Warehouses, APIs &amp; SaaS • Delta Sync • Tenant &amp; RBAC</p>
          </div>
          <button type="button" aria-label="Close connectors modal" onClick={onClose} className="min-w-[44px] min-h-[44px] flex items-center justify-center p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-emerald-700 hover:bg-slate-100 dark:hover:bg-emerald-500/10">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 pt-3 space-y-3 border-b border-slate-100 dark:border-emerald-500/10 pb-3">
          <div className="relative">
            <Search size={14} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 dark:text-emerald-400" />
            <input
              aria-label="Search 36 integrations"
              type="text"
              placeholder="Search 36 integrations (postgres, mysql, supabase, mongo, redis, graphql, jira...)"
              className="w-full bg-slate-50 dark:bg-emerald-900/40 border border-slate-300 dark:border-emerald-500/25 rounded-xl pl-9 pr-3 py-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map(cat => (
              <button
                type="button"
                key={cat}
                onClick={() => handleCategoryChange(cat)}
                className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
                  category === cat
                    ? "bg-emerald-500 text-white shadow-md"
                    : "bg-slate-100 dark:bg-emerald-950/50 text-slate-500 dark:text-emerald-300/70 hover:text-emerald-500"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSync} className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
            {filtered.map(item => (
              <button
                type="button"
                key={item.type}
                onClick={() => setSelected(item.type)}
                className={`p-3 rounded-2xl border text-left transition-all ${
                  selected === item.type
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                    : "border-slate-200 dark:border-emerald-500/15 hover:border-emerald-500/40"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-black truncate">{item.label}</span>
                  {item.envConfigured && (
                    <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-300">.ENV</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">{item.description}</p>
              </button>
            ))}
          </div>

          {currentMeta?.envConfigured && (
            <div className="px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
              <ShieldCheck size={14} /> Server `.env` credentials detected for {currentMeta.label}. Leave token blank to use server defaults.
            </div>
          )}

          {selected === "web" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1">
                <label className={labelCls}>Page or Sitemap XML URL</label>
                <input className={inputCls} placeholder="https://docs.example.com/sitemap.xml" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} required />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Max Pages (1-25)</label>
                <input type="number" min={1} max={25} className={inputCls} value={form.maxPages} onChange={e => setForm({ ...form, maxPages: parseInt(e.target.value, 10) || 5 })} />
              </div>
            </div>
          )}

          {selected === "github" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>Repository (owner/repo)</label>
                <input className={inputCls} placeholder="vercel/ai" value={form.repo} onChange={e => setForm({ ...form, repo: e.target.value })} required />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Branch</label>
                <input className={inputCls} placeholder="main" value={form.branch} onChange={e => setForm({ ...form, branch: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Path Prefix (Optional)</label>
                <input className={inputCls} placeholder="docs/" value={form.pathPrefix} onChange={e => setForm({ ...form, pathPrefix: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>GitHub Token (Optional for public)</label>
                <input type="password" className={inputCls} placeholder="ghp_..." value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-emerald-200 sm:col-span-2">
                <input type="checkbox" checked={!!form.includeIssues} onChange={e => setForm({ ...form, includeIssues: e.target.checked })} />
                Include open GitHub issues
              </label>
            </div>
          )}

          {(selected === "notion" || selected === "gmail") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>{selected === "gmail" ? "Gmail Search Query" : "Search Query (Optional)"}</label>
                <input className={inputCls} placeholder={selected === "gmail" ? "in:inbox label:engineering" : "Onboarding"} value={form.query} onChange={e => setForm({ ...form, query: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>{selected === "gmail" ? "Gmail OAuth Access Token" : "Notion Integration Token"}</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {(selected === "confluence" || selected === "jira" || selected === "zendesk") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>Base URL</label>
                <input className={inputCls} placeholder={selected === "zendesk" ? "https://company.zendesk.com" : "https://company.atlassian.net"} value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Account Email</label>
                <input className={inputCls} placeholder="user@company.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>API Token</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
              {selected === "confluence" && (
                <div className="space-y-1">
                  <label className={labelCls}>Space Key (Optional)</label>
                  <input className={inputCls} placeholder="ENG" value={form.spaceKey} onChange={e => setForm({ ...form, spaceKey: e.target.value })} />
                </div>
              )}
              {selected === "jira" && (
                <div className="space-y-1">
                  <label className={labelCls}>JQL Filter</label>
                  <input className={inputCls} placeholder="project = ENG ORDER BY updated DESC" value={form.jql} onChange={e => setForm({ ...form, jql: e.target.value })} />
                </div>
              )}
            </div>
          )}

          {selected === "asana" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>Asana Project GID</label>
                <input className={inputCls} placeholder="1201234567890" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })} required />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Personal Access Token</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {selected === "linear" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>Team Key (Optional)</label>
                <input className={inputCls} placeholder="ENG" value={form.teamId} onChange={e => setForm({ ...form, teamId: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Linear API Key</label>
                <input type="password" className={inputCls} placeholder="lin_api_..." value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {(selected === "slack" || selected === "discord" || selected === "msteams" || selected === "meta") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {selected === "msteams" && (
                <div className="space-y-1">
                  <label className={labelCls}>Teams Team ID</label>
                  <input className={inputCls} value={form.teamId} onChange={e => setForm({ ...form, teamId: e.target.value })} required />
                </div>
              )}
              <div className="space-y-1">
                <label className={labelCls}>{selected === "meta" ? "Page / Node ID (default: me)" : "Channel ID"}</label>
                <input className={inputCls} placeholder={selected === "meta" ? "me" : "C0123456789"} value={form.channelId} onChange={e => setForm({ ...form, channelId: e.target.value })} required={selected !== "meta"} />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Access / Bot Token</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {(selected === "s3" || selected === "gcs") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelCls}>Bucket Name</label>
                <input className={inputCls} placeholder="company-docs" value={form.bucket} onChange={e => setForm({ ...form, bucket: e.target.value })} required />
              </div>
              <div className="space-y-1">
                <label className={labelCls}>Prefix (Optional)</label>
                <input className={inputCls} placeholder="knowledge/" value={form.prefix} onChange={e => setForm({ ...form, prefix: e.target.value })} />
              </div>
              {selected === "gcs" ? (
                <div className="space-y-1 sm:col-span-2">
                  <label className={labelCls}>GCS OAuth Access Token</label>
                  <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>Region</label>
                    <input className={inputCls} placeholder="us-east-1" value={form.region} onChange={e => setForm({ ...form, region: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Custom Endpoint (MinIO/R2)</label>
                    <input className={inputCls} placeholder="https://s3.example.com" value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Access Key ID</label>
                    <input className={inputCls} value={form.accessKeyId} onChange={e => setForm({ ...form, accessKeyId: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Secret Access Key</label>
                    <input type="password" className={inputCls} value={form.secretAccessKey} onChange={e => setForm({ ...form, secretAccessKey: e.target.value })} />
                  </div>
                </>
              )}
            </div>
          )}

          {(selected === "gdrive" || selected === "gsheets" || selected === "sharepoint") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {selected === "gsheets" ? (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>Spreadsheet ID</label>
                    <input className={inputCls} placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })} required />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>Range</label>
                    <input className={inputCls} placeholder="A1:Z200" value={form.query} onChange={e => setForm({ ...form, query: e.target.value })} />
                  </div>
                </>
              ) : (
                <div className="space-y-1">
                  <label className={labelCls}>{selected === "gdrive" ? "Folder ID (Optional)" : "SharePoint Site ID (Optional)"}</label>
                  <input className={inputCls} value={selected === "gdrive" ? form.folderId : form.siteId} onChange={e => setForm({ ...form, [selected === "gdrive" ? "folderId" : "siteId"]: e.target.value })} />
                </div>
              )}
              <div className="space-y-1">
                <label className={labelCls}>OAuth Access Token</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {(selected === "salesforce" || selected === "hubspot") && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {selected === "salesforce" ? (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>Salesforce Instance URL</label>
                    <input className={inputCls} placeholder="https://myorg.my.salesforce.com" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>SOQL Query (SELECT only)</label>
                    <input className={inputCls} placeholder="SELECT Id, Name FROM Account LIMIT 25" value={form.sqlQuery} onChange={e => setForm({ ...form, sqlQuery: e.target.value })} />
                  </div>
                </>
              ) : (
                <div className="space-y-1">
                  <label className={labelCls}>Object Type (contacts/companies/deals/tickets)</label>
                  <input className={inputCls} placeholder="deals" value={form.query} onChange={e => setForm({ ...form, query: e.target.value })} />
                </div>
              )}
              <div className="space-y-1 sm:col-span-2">
                <label className={labelCls}>API / OAuth Token</label>
                <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
              </div>
            </div>
          )}

          {(selected === "postgres" || selected === "mysql" || selected === "bigquery" || selected === "snowflake" || selected === "mongodb" || selected === "supabase" || selected === "clickhouse" || selected === "databricks" || selected === "turso" || selected === "elasticsearch" || selected === "firestore" || selected === "dynamodb" || selected === "airtable" || selected === "redis_db" || selected === "graphql" || selected === "rest_api") && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(selected === "postgres" || selected === "mysql" || selected === "redis_db") && (
                <div className="sm:col-span-2 space-y-1">
                  <label className={labelCls}>{selected === "mysql" ? "MySQL Connection URL" : selected === "redis_db" ? "Redis Connection URL" : "PostgreSQL Connection URL"}</label>
                  <input type="password" className={inputCls} placeholder={selected === "mysql" ? "mysql://readonly:pass@host:3306/app" : selected === "redis_db" ? "redis://:pass@host:6379/0" : "postgresql://readonly:pass@db.example.com:5432/app"} value={form.connectionString} onChange={e => setForm({ ...form, connectionString: e.target.value })} />
                </div>
              )}
              {(selected === "bigquery" || selected === "firestore" || selected === "airtable") && (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>{selected === "airtable" ? "Airtable Base ID" : "GCP / Firebase Project ID"}</label>
                    <input className={inputCls} placeholder={selected === "airtable" ? "appXXXXXXXXXXXXXX" : "my-gcp-project"} value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>{selected === "airtable" ? "Airtable PAT" : "OAuth Access Token"}</label>
                    <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
                  </div>
                </>
              )}
              {(selected === "snowflake" || selected === "mongodb" || selected === "supabase" || selected === "clickhouse" || selected === "databricks" || selected === "turso" || selected === "elasticsearch" || selected === "graphql" || selected === "rest_api") && (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>
                      {selected === "supabase" ? "Supabase Project URL" : selected === "graphql" || selected === "rest_api" ? "Endpoint URL" : "Database / API URL"}
                    </label>
                    <input className={inputCls} placeholder={selected === "supabase" ? "https://xxxx.supabase.co" : "https://..."} value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>API Key / Auth Token</label>
                    <input type="password" className={inputCls} value={form.apiToken} onChange={e => setForm({ ...form, apiToken: e.target.value })} />
                  </div>
                </>
              )}
              {selected === "dynamodb" && (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>DynamoDB Table Name</label>
                    <input className={inputCls} placeholder="knowledge_items" value={form.tableName} onChange={e => setForm({ ...form, tableName: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>AWS Region</label>
                    <input className={inputCls} placeholder="us-east-1" value={form.region} onChange={e => setForm({ ...form, region: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <label className={labelCls}>AWS Access Key ID</label>
                    <input className={inputCls} value={form.accessKeyId} onChange={e => setForm({ ...form, accessKeyId: e.target.value })} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className={labelCls}>AWS Secret Access Key</label>
                    <input type="password" className={inputCls} value={form.secretAccessKey} onChange={e => setForm({ ...form, secretAccessKey: e.target.value })} />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <label className={labelCls}>Max Rows / Keys</label>
                <input type="number" min={1} max={500} className={inputCls} value={form.maxRows} onChange={e => setForm({ ...form, maxRows: parseInt(e.target.value, 10) || 100 })} />
              </div>
              {selected === "databricks" && (
                <div className="space-y-1">
                  <label className={labelCls}>SQL Warehouse ID</label>
                  <input className={inputCls} placeholder="abc123def456" value={form.warehouseId} onChange={e => setForm({ ...form, warehouseId: e.target.value })} />
                </div>
              )}
              {(selected === "supabase" || selected === "firestore" || selected === "airtable") && (
                <div className="sm:col-span-2 space-y-1">
                  <label className={labelCls}>{selected === "firestore" ? "Collection Name" : "Table Name"}</label>
                  <input className={inputCls} placeholder="articles" value={form.tableName} onChange={e => setForm({ ...form, tableName: e.target.value })} />
                </div>
              )}
              {selected === "elasticsearch" && (
                <div className="space-y-1">
                  <label className={labelCls}>Index Name</label>
                  <input className={inputCls} placeholder="docs_index" value={form.indexName} onChange={e => setForm({ ...form, indexName: e.target.value })} />
                </div>
              )}
              {selected === "redis_db" && (
                <div className="sm:col-span-2 space-y-1">
                  <label className={labelCls}>Key SCAN Pattern</label>
                  <input className={inputCls} placeholder="docs:*" value={form.keyPattern} onChange={e => setForm({ ...form, keyPattern: e.target.value })} />
                </div>
              )}
              {selected === "mongodb" ? (
                <>
                  <div className="space-y-1">
                    <label className={labelCls}>Database</label>
                    <input className={inputCls} placeholder="prod" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className={labelCls}>Collection</label>
                    <input className={inputCls} placeholder="knowledge_base" value={form.query} onChange={e => setForm({ ...form, query: e.target.value })} />
                  </div>
                </>
              ) : selected === "graphql" ? (
                <div className="sm:col-span-3 space-y-1">
                  <label className={labelCls}>Read-Only GraphQL Query</label>
                  <input className={inputCls} placeholder="{ articles(limit: 20) { id title body } }" value={form.sqlQuery} onChange={e => setForm({ ...form, sqlQuery: e.target.value })} />
                </div>
              ) : (selected === "postgres" || selected === "mysql" || selected === "bigquery" || selected === "snowflake" || selected === "clickhouse" || selected === "databricks" || selected === "turso") ? (
                <div className="sm:col-span-3 space-y-1">
                  <label className={labelCls}>Read-Only SELECT SQL Query</label>
                  <input className={inputCls} placeholder="SELECT id, title, summary FROM knowledge_articles" value={form.sqlQuery} onChange={e => setForm({ ...form, sqlQuery: e.target.value })} />
                </div>
              ) : null}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-emerald-500/10 grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div className="space-y-2">
              <div className="space-y-1">
                <label className={labelCls}>RBAC Allowed Roles (comma-separated, or *)</label>
                <input className={inputCls} placeholder="member, engineering" value={allowedRoles} onChange={e => setAllowedRoles(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-[11px] font-bold text-slate-600 dark:text-emerald-200 cursor-pointer">
                <input type="checkbox" checked={runAsync} onChange={e => setRunAsync(e.target.checked)} />
                Run as Async Background Job (`POST /api/jobs`)
              </label>
            </div>
            <button
              type="submit"
              disabled={syncing}
              className="glossy-emerald text-white py-3.5 px-6 rounded-xl text-[11px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              {syncing ? "Syncing & Indexing..." : `${runAsync ? "Queue Job:" : "Sync"} ${currentMeta?.label || selected}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function AuditApiModal({
  isOpen,
  onClose,
  config,
}: {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
}) {
  const [tab, setTab] = useState<"audit" | "eval" | "api">("audit");
  const [events, setEvents] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Eval Harness state
  const [evalText, setEvalText] = useState(
    "What is the primary topic of the indexed document?\nList any key metrics or dates mentioned."
  );
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalSummary, setEvalSummary] = useState<any>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const tenant = encodeURIComponent(config.tenantId || "default");
      const [auditRes, jobsRes] = await Promise.all([
        fetch(`/api/audit?tenantId=${tenant}`),
        fetch(`/api/jobs?tenantId=${tenant}`),
      ]);
      if (auditRes.ok) {
        const d = await auditRes.json();
        setEvents(d.events || []);
      }
      if (jobsRes.ok) {
        const j = await jobsRes.json();
        setJobs(j.jobs || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const tenant = encodeURIComponent(config.tenantId || "default");
    Promise.all([
      fetch(`/api/audit?tenantId=${tenant}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/jobs?tenantId=${tenant}`).then(r => (r.ok ? r.json() : null)),
    ])
      .then(([auditData, jobsData]) => {
        if (!active) return;
        if (auditData?.events) setEvents(auditData.events);
        if (jobsData?.jobs) setJobs(jobsData.jobs);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isOpen, config.tenantId]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const runEval = async () => {
    setEvalError(null);
    setEvalRunning(true);
    try {
      const lines = evalText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 10);
      const cases = lines.map(line => {
        const [question, kwRaw, expectedFilename] = line.split("|").map(s => s.trim());
        const expectedKeywords = kwRaw ? kwRaw.split(",").map(k => k.trim()).filter(Boolean) : undefined;
        return { question, expectedKeywords, expectedFilename: expectedFilename || undefined };
      });
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, cases }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEvalError(data.error || "Evaluation failed");
      } else {
        setEvalSummary(data.summary);
      }
    } catch (err: any) {
      setEvalError(err?.message || "Evaluation failed");
    } finally {
      setEvalRunning(false);
    }
  };

  if (!isOpen) return null;

  const queryCurl = `curl -X POST http://localhost:3000/api/v1/query \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $RAGCHAT_API_KEY" \\
  -d '{"query":"Summarize Q3 policy","config":{"provider":"${config.provider || "openai"}","modelId":"${config.modelId || "gpt-4o-mini"}","apiKey":"YOUR_KEY","useAgenticRag":${!!config.useAgenticRag},"tenantId":"${config.tenantId || "default"}","userRoles":${JSON.stringify(config.userRoles || ["member"])}}}'`;

  return (
    <div role="dialog" aria-modal="true" aria-label="Enterprise Operations, Evaluation and API" className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-white dark:bg-[#06151c] border border-slate-200 dark:border-emerald-500/25 rounded-2xl shadow-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 dark:border-emerald-500/15 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Activity size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <div>
              <h3 className="text-lg font-bold tracking-tight text-slate-900 dark:text-emerald-50">Enterprise Ops, Eval &amp; API</h3>
              <p className="text-[11px] font-semibold text-slate-600 dark:text-emerald-300/75">Tenant: {config.tenantId || "default"} • JWT / Audit / Async Jobs / RAG Eval</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Refresh audit and job logs" onClick={loadData} className="min-w-[44px] min-h-[44px] flex items-center justify-center p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-emerald-700 hover:bg-slate-100 dark:hover:bg-emerald-500/10" title="Refresh">
              <RefreshCw size={16} aria-hidden="true" className={loading ? "animate-spin" : ""} />
            </button>
            <button type="button" aria-label="Close enterprise operations modal" onClick={onClose} className="min-w-[44px] min-h-[44px] flex items-center justify-center p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-emerald-700 hover:bg-slate-100 dark:hover:bg-emerald-500/10">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="px-6 pt-3 flex flex-wrap gap-2 border-b border-slate-100 dark:border-emerald-500/10 pb-3">
          {[
            { id: "audit", label: "Audit & Jobs", icon: Activity },
            { id: "eval", label: "Eval Harness", icon: FlaskConical },
            { id: "api", label: "Headless API", icon: Terminal },
          ].map(t => (
            <button
              type="button"
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
                tab === t.id
                  ? "bg-emerald-500 text-white shadow-md"
                  : "bg-slate-100 dark:bg-emerald-950/50 text-slate-500 dark:text-emerald-300/70"
              }`}
            >
              <t.icon size={12} /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {tab === "audit" && (
            <>
              <div className="space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Async Ingestion Jobs ({jobs.length})</span>
                {jobs.length === 0 ? (
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 py-4 text-center border border-dashed border-slate-300 dark:border-emerald-500/25 rounded-2xl">
                    No async jobs queued yet (`POST /api/jobs`).
                  </p>
                ) : (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {jobs.map(job => (
                      <div key={job.id} className="p-3 rounded-xl border border-slate-200 dark:border-emerald-500/15 bg-slate-50/70 dark:bg-emerald-950/30 flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 font-bold uppercase text-[9px]">{job.status}</span>
                          <span className="font-bold">{job.source}</span>
                          <span className="text-slate-600 dark:text-slate-400 text-[10px]">{job.chunkCount} chunks • {job.indexedFiles?.length || 0} files</span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-600 dark:text-slate-400">{job.id.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:text-emerald-300/80">Recent Tenant Audit Events ({events.length})</span>
                {events.length === 0 ? (
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 py-6 text-center border border-dashed border-slate-300 dark:border-emerald-500/25 rounded-2xl">
                    No audit events recorded yet for tenant &ldquo;{config.tenantId || "default"}&rdquo;.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {events.map((ev) => (
                      <div key={ev.id} className="p-3 rounded-xl border border-slate-200 dark:border-emerald-500/15 bg-slate-50/70 dark:bg-emerald-950/30 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 font-bold uppercase text-[9px]">{ev.action}</span>
                          <span className="font-bold text-slate-700 dark:text-emerald-100">{ev.vectorStore || ev.provider || "system"}</span>
                          <span className="text-slate-600 dark:text-slate-400 font-mono text-[10px]">{JSON.stringify(ev.details)}</span>
                        </div>
                        <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === "eval" && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  Golden Test Cases (1 per line: `question | kw1, kw2 | optional_filename`)
                </label>
                <textarea
                  rows={4}
                  className="w-full bg-slate-50 dark:bg-emerald-900/40 border border-slate-300 dark:border-emerald-500/25 rounded-2xl p-3 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                  value={evalText}
                  onChange={e => setEvalText(e.target.value)}
                />
              </div>
              <button
                type="button"
                onClick={runEval}
                disabled={evalRunning}
                className="glossy-emerald text-white px-5 py-3 rounded-xl text-[11px] font-bold uppercase tracking-wide flex items-center gap-2 disabled:opacity-50"
              >
                <Play size={14} aria-hidden="true" /> {evalRunning ? "Evaluating..." : "Run Golden Benchmark"}
              </button>

              {evalError && (
                <p className="text-xs font-bold text-red-500 bg-red-500/10 border border-red-500/20 p-3 rounded-xl">{evalError}</p>
              )}

              {evalSummary && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {[
                      { label: "Pass Rate", val: `${evalSummary.passRate}%` },
                      { label: "Avg Recall@K", val: evalSummary.avgRecall },
                      { label: "Avg MRR", val: evalSummary.avgMrr },
                      { label: "Groundedness", val: `${evalSummary.avgGroundedness}%` },
                      { label: "Avg Latency", val: `${evalSummary.avgLatencyMs}ms` },
                    ].map(m => (
                      <div key={m.label} className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-center">
                        <div className="text-[9px] font-black uppercase text-emerald-600 dark:text-emerald-400">{m.label}</div>
                        <div className="text-sm font-black text-slate-800 dark:text-emerald-50 mt-0.5">{m.val}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {evalSummary.results?.map((r: any, idx: number) => (
                      <div key={idx} className="p-3 rounded-xl border border-slate-200 dark:border-emerald-500/15 text-xs space-y-1">
                        <div className="flex items-center justify-between font-bold">
                          <span className="truncate">{r.question}</span>
                          <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${r.passed ? "bg-emerald-500/20 text-emerald-600" : "bg-red-500/20 text-red-500"}`}>
                            {r.passed ? "PASS" : "FAIL"} • R:{r.recallAtK} • G:{r.groundedness}%
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-emerald-200/70 line-clamp-2">{r.answer}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "api" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Headless Query API (`POST /api/v1/query`)</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(queryCurl)}
                  className="flex items-center gap-1 text-[10px] font-black uppercase text-emerald-600 hover:underline"
                >
                  <Copy size={12} /> Copy cURL
                </button>
              </div>
              <pre className="p-4 rounded-2xl bg-slate-900 text-emerald-300 text-[11px] overflow-x-auto font-mono">{queryCurl}</pre>
              <p className="text-[11px] font-bold text-slate-400">
                Endpoints available: `POST /api/v1/query`, `POST /api/v1/ingest`, `POST /api/jobs` (async), `POST /api/eval`, `GET /api/audit`. Set `RAGCHAT_JWT_SECRET` in `.env` for strict server-signed HS256 JWT tenant/RBAC enforcement.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
