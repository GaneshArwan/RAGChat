"use client";

import { useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { 
  Upload, 
  Send, 
  FileText, 
  ChevronDown, 
  Settings, 
  X, 
  Shield, 
  PanelLeftClose, 
  PanelLeftOpen,
  PlusCircle,
  MessageSquare,
  Key,
  Trash2,
  CheckSquare,
  Square,
  HelpCircle,
  Database,
  Cpu,
  Zap,
  Globe,
  Binary,
  Lock,
  Server,
  Plug,
  Activity
} from "lucide-react";
import { AppConfig, DEFAULT_CONFIGS } from "@/lib/config";
import { ConnectorsHubModal, AuditApiModal } from "@/components/EnterpriseModals";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function RAGChatPage() {
  // Configuration State
  const initialConfig: AppConfig = {
    provider: "" as any,
    apiKey: "",
    modelId: "",
    baseUrl: "",
    embeddingProvider: "" as any,
    embeddingModelId: "",
    embeddingKeySource: "main",
    embeddingApiKey: "",
    embeddingBaseUrl: "",
    useReranking: false,
    rerankProvider: "" as any,
    rerankModelId: "",
    rerankKeySource: "main",
    rerankApiKey: "",
    rerankBaseUrl: "",
    useCag: false,
    useHybridSearch: true,
    useQueryRewrite: true,
    useAgenticRag: false,
    useGraphRag: false,
    topK: 5,
    vectorStoreProvider: "chroma",
    vectorStoreUrl: "",
    vectorStoreApiKey: "",
    vectorStoreIndex: "",
    tenantId: "default",
    userRoles: ["member"],
    enablePiiRedaction: false,
    enableAuditLog: true,
    similarityThreshold: 0.3,
    contextFormat: "json",
    useRedis: false,
    redisProvider: "" as any,
    redisUrl: "",
    redisToken: "",
    redisHost: "",
    redisPort: 6379,
    redisPassword: "",
    redisDb: 0,
    redisTls: false,
    redisRateLimitTtl: 60,
    redisCacheTtl: 3600
  };

  const [config, setConfig] = useState<AppConfig>(initialConfig);

  // UI State
  const [showSettings, setShowSettings] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [files, setFiles] = useState<FileList | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [indexedDocuments, setIndexedDocuments] = useState<{name: string, active: boolean}[]>([]);
  const [localInput, setLocalInput] = useState("");
  
  const isConfigComplete = !!(
    // 1. Core Inference
    config.provider && 
    config.modelId && 
    (config.provider === "custom" ? config.baseUrl : config.apiKey) &&
    
    // 2. Embedding Layer
    config.embeddingProvider && 
    config.embeddingModelId && 
    (config.embeddingProvider === "custom" ? config.embeddingBaseUrl : (config.embeddingKeySource === "main" ? config.apiKey : config.embeddingApiKey)) &&
    
    // 3. Conditional Reranking
    (!config.useReranking || (
      config.rerankProvider && 
      (config.rerankProvider === "default" || (
        config.rerankModelId && 
        (config.rerankProvider === "custom"
          ? config.rerankBaseUrl
          : (config.rerankKeySource === "custom"
              ? config.rerankApiKey
              : (config.rerankKeySource === "embedding"
                  ? (config.embeddingKeySource === "main" ? config.apiKey : config.embeddingApiKey)
                  : config.apiKey)))
      ))
    )) &&
    
    // 4. Conditional Redis
    (!config.useRedis || (
      config.redisProvider && 
      (config.redisProvider === "standard" ? config.redisHost : (config.redisUrl && config.redisToken))
    ))
  );
  const hasApiKey = !!(config.provider === "custom" || config.apiKey);

  const [notification, setNotification] = useState<{message: string, type: 'error' | 'success' | 'info'} | null>(null);
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [dbStatus, setDbStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showConnectorsModal, setShowConnectorsModal] = useState(false);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [rolesInput, setRolesInput] = useState("member");

  const fieldErr = (missing: boolean) =>
    showFieldErrors && !isConfigComplete && missing ? "border-red-500 ring-2 ring-red-500/20" : "";

  // Database Health Check
  useEffect(() => {
    const checkHealth = async () => {
      if (config.vectorStoreProvider && config.vectorStoreProvider !== "chroma" && !config.vectorStoreUrl) {
        setDbStatus('offline');
        return;
      }
      try {
        const params = new URLSearchParams({
          vectorStoreProvider: config.vectorStoreProvider || "chroma",
        });
        if (config.vectorStoreUrl) params.set("vectorStoreUrl", config.vectorStoreUrl);
        if (config.vectorStoreIndex) params.set("vectorStoreIndex", config.vectorStoreIndex);
        const headers: Record<string, string> = {};
        if (config.vectorStoreApiKey) headers["x-vector-store-key"] = config.vectorStoreApiKey;

        const response = await fetch(`/api/health?${params.toString()}`, { headers });
        setDbStatus(response.ok ? 'online' : 'offline');
      } catch {
        setDbStatus('offline');
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [config.vectorStoreProvider, config.vectorStoreUrl, config.vectorStoreApiKey, config.vectorStoreIndex]);

  // Fetch Library on Load or Tenant/Vector Store Change
  useEffect(() => {
    const fetchLibrary = async () => {
      if (config.vectorStoreProvider && config.vectorStoreProvider !== "chroma" && !config.vectorStoreUrl) {
        setIndexedDocuments([]);
        return;
      }
      try {
        const params = new URLSearchParams({
          tenantId: config.tenantId || "default",
          roles: (config.userRoles || ["member"]).join(","),
          vectorStoreProvider: config.vectorStoreProvider || "chroma",
        });
        if (config.vectorStoreUrl) params.set("vectorStoreUrl", config.vectorStoreUrl);
        if (config.vectorStoreIndex) params.set("vectorStoreIndex", config.vectorStoreIndex);
        const headers: Record<string, string> = {};
        if (config.vectorStoreApiKey) headers["x-vector-store-key"] = config.vectorStoreApiKey;

        const response = await fetch(`/api/documents?${params.toString()}`, { headers });
        if (response.ok) {
          const data = await response.json();
          if (data.documents) {
            setIndexedDocuments(data.documents.map((name: string) => ({ name, active: true })));
          }
        }
      } catch (e) {
        console.error("Failed to fetch library", e);
      }
    };
    fetchLibrary();
  }, [config.tenantId, config.userRoles, config.vectorStoreProvider, config.vectorStoreUrl, config.vectorStoreApiKey, config.vectorStoreIndex]);

  const chat = useChat({
    onError: (err) => {
      setNotification({ 
        message: `Model Error: ${err.message || "Failed to reach inference provider."}`, 
        type: 'error' 
      });
    }
  });

  const { messages = [] } = chat;
  const c = chat as any;
  const isChatLoading = c.isLoading || c.status === "submitted" || c.status === "streaming";

  // Auto-hide notification
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Auto-scroll chat
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isChatLoading]);

  const onChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasApiKey || !isConfigComplete) {
      setShowFieldErrors(true);
      setNotification({ message: "Action Blocked: Please resolve the highlighted configuration errors in the sidebar.", type: 'error' });
      setShowSettings(true);
      return;
    }
    if (indexedDocuments.length === 0) {
      setNotification({ message: "Context Required: Please upload at least one file to provide the model with context.", type: 'info' });
      return;
    }
    if (!localInput.trim() || isChatLoading) return;
    
    const activeDocs = indexedDocuments.filter(d => d.active).map(d => d.name);
    if (activeDocs.length === 0) {
      setNotification({ message: "Context Required: Please ensure at least one document is checked in the library.", type: 'info' });
      return;
    }
    
    const body = { config, activeFilenames: activeDocs };
    const currentInput = localInput;
    setLocalInput("");

    try {
      const c = chat as any;
      if (typeof c.sendMessage === 'function') await c.sendMessage({ text: currentInput }, { body });
      else if (typeof c.append === 'function') await c.append({ role: "user", content: currentInput }, { body });
      else if (typeof c.handleSubmit === 'function') await c.handleSubmit(e, { body });
    } catch (err: any) {
      setNotification({ message: `Inference Error: ${err.message || "Connection refused by provider."}`, type: 'error' });
      setLocalInput(currentInput);
    }
  };

  const handleFileUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!isConfigComplete) {
      setShowFieldErrors(true);
      setNotification({ message: "Action Blocked: Please complete the System Configuration before indexing data.", type: 'error' });
      setShowSettings(true);
      return;
    }

    if (!files || files.length === 0) {
      setNotification({ message: "No files staged. Please select files first.", type: 'info' });
      return;
    }

    const effectiveEmbeddingKey = config.embeddingKeySource === "custom" ? (config.embeddingApiKey || "") : (config.apiKey || "");
    const embeddingProvider = config.embeddingProvider || config.provider;
    const needsKey = !["custom", "default"].includes(embeddingProvider);

    if (needsKey && !effectiveEmbeddingKey) {
      setShowFieldErrors(true);
      setNotification({ message: "Upload Blocked: API Key is required for indexing (embeddings).", type: 'error' });
      setShowSettings(true);
      return;
    }

    setIsUploading(true);
    setUploadStatus("Syncing...");
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) formData.append("files", files[i]);
    formData.append("config", JSON.stringify(config));
    try {
      const response = await fetch("/api/upload", { method: "POST", body: formData });
      if (response.ok) {
        const data = await response.json();
        const uploadedNames: string[] = Array.isArray(data.indexedFiles) && data.indexedFiles.length > 0
          ? data.indexedFiles
          : Array.from(files).map(f => f.name);
        setUploadStatus("Success!");
        setIndexedDocuments(prev => {
          const updated = [...prev];
          uploadedNames.forEach(name => { if (!updated.find(d => d.name === name)) updated.push({ name, active: true }); });
          return updated;
        });
        if (Array.isArray(data.skippedFiles) && data.skippedFiles.length > 0) {
          setNotification({ message: `Skipped files: ${data.skippedFiles.join(", ")}`, type: 'info' });
        }
        setTimeout(() => setUploadStatus(null), 3000);
        setFiles(null);
      } else {
        const error = await response.json();
        setUploadStatus(`Error: ${error.error || "Failed"}`);
      }
    } catch (err) { setUploadStatus("Error occurred."); } finally { setIsUploading(false); }
  };

  const toggleDoc = (name: string) => {
    setIndexedDocuments(prev => prev.map(d => d.name === name ? { ...d, active: !d.active } : d));
  };

  const removeDoc = (name: string) => {
    setDeleteConfirm(name);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const name = deleteConfirm;
    setDeleteConfirm(null);
    try {
      const response = await fetch("/api/documents", { 
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name, config })
      });
      if (response.ok) {
        setIndexedDocuments(prev => prev.filter(d => d.name !== name));
        setNotification({ message: `Successfully removed ${name}`, type: 'success' });
      } else {
        const err = await response.json();
        throw new Error(err.error || "Failed to delete");
      }
    } catch (e: any) { 
      setNotification({ message: `Delete Error: ${e.message}`, type: 'error' });
    }
  };

  const updateProvider = (provider: AppConfig["provider"]) => {
    setConfig(prev => ({
      ...prev,
      provider,
      apiKey: "",
      modelId: "",
      baseUrl: "",
    }));
  };

  const getMessageContent = (m: any): string => {
    if (!m) return "";
    if (typeof m.content === 'string' && m.content) return m.content;
    if (m.parts && Array.isArray(m.parts)) {
      return m.parts.map((p: any) => typeof p === 'string' ? p : p?.text || "").join("");
    }
    return typeof m.content === 'undefined' ? "" : String(m.content);
  };

  const getSources = (m: any) => {
    if (!m || m.role === "user") return null;
    if (m.parts && Array.isArray(m.parts)) {
      const dataPart = m.parts.find((p: any) => p && typeof p === 'object' && p.type === 'data-custom' && p.data?.type === 'sources');
      return dataPart?.data?.sources || null;
    }
    return null;
  };

  const getPipelineInfo = (m: any) => {
    if (!m || m.role === "user") return null;
    if (m.parts && Array.isArray(m.parts)) {
      const dataPart = m.parts.find((p: any) => p && typeof p === 'object' && p.type === 'data-custom' && p.data?.type === 'pipeline');
      return dataPart?.data?.pipeline || null;
    }
    return null;
  };

  const getGroundedness = (m: any) => {
    if (!m || m.role === "user") return null;
    if (m.parts && Array.isArray(m.parts)) {
      const dataPart = m.parts.find((p: any) => p && typeof p === 'object' && p.type === 'data-custom' && p.data?.type === 'groundedness');
      return dataPart?.data?.groundedness || null;
    }
    return null;
  };

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-emerald-50/90 overflow-hidden font-sans selection:bg-emerald-200 dark:selection:bg-emerald-500/30">
      
      {/* Notification Toast */}
      {notification && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
          "fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3.5 max-w-[calc(100vw-2rem)] rounded-2xl shadow-lg border",
          notification.type === 'error' ? "bg-red-600 border-red-500 text-white" : 
          notification.type === 'success' ? "bg-emerald-700 border-emerald-600 text-white" :
          "bg-slate-900 border-slate-700 text-white"
        )}>
          <span className="shrink-0" aria-hidden="true">{notification.type === 'error' ? <Shield size={18} /> : notification.type === 'success' ? <CheckSquare size={18} /> : <HelpCircle size={18} />}</span>
          <p className="text-xs font-bold tracking-wide leading-snug">{notification.message}</p>
          <button type="button" aria-label="Close notification" onClick={() => setNotification(null)} className="ml-2 shrink-0 p-1 rounded hover:bg-white/15 transition-colors"><X size={14} /></button>
        </div>
      )}

      {/* Mobile Sidebar Backdrop */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-950/50 z-10 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 md:static bg-white dark:bg-[#0b1220] border-r border-slate-200 dark:border-emerald-500/15 transition-all duration-300 flex flex-col z-20 shrink-0",
        isSidebarOpen ? "w-[85vw] max-w-[340px] md:w-[340px] translate-x-0" : "-translate-x-full md:translate-x-0 w-0 opacity-0 pointer-events-none overflow-hidden"
      )}>
        {/* Header */}
        <div className="p-6 border-b border-slate-200 dark:border-emerald-500/15 flex items-center justify-between shrink-0">
          <div className="flex flex-col -space-y-1">
            <h1 className="font-bold text-xl tracking-tight text-slate-900 dark:text-emerald-300">RAGChat</h1>
          </div>
          <button type="button" aria-label="Close sidebar" onClick={() => setIsSidebarOpen(false)} className="text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-emerald-500/10">
            <PanelLeftClose size={20} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-8 no-scrollbar">
          
          <section className="space-y-4">
             <div className="flex items-center gap-2 px-1">
               <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-emerald-300/75">Data Indexing</h3>
             </div>
             
             <form onSubmit={handleFileUpload} className="space-y-4">
               <div className="group relative border-2 border-dashed border-slate-300 dark:border-emerald-500/20 rounded-2xl p-6 text-center hover:border-emerald-600/50 hover:bg-emerald-50/30 dark:hover:bg-emerald-500/5 transition-colors cursor-pointer overflow-hidden">
                 <input aria-label="Select documents to index" type="file" multiple accept=".pdf,.docx,.csv,.json,.png,.jpg,.jpeg,.webp,.txt,.md,.ts,.js,.py,.css,.html" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" onChange={(e) => {
                    if (!e.target.files) return;
                    const newFiles = Array.from(e.target.files);
                    setFiles((prev) => {
                      const dt = new DataTransfer();
                      const existingFiles = prev ? Array.from(prev) : [];
                      const combined = [...existingFiles];
                      newFiles.forEach(nf => { if (!combined.some(ef => ef.name === nf.name)) combined.push(nf); });
                      combined.forEach(f => dt.items.add(f));
                      return dt.files;
                    });
                    e.target.value = "";
                 }} />
                 <div className="flex flex-col items-center gap-2">
                   <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-500 group-hover:scale-110 transition-transform">
                     <PlusCircle size={20} />
                   </div>
                   <div className="space-y-1">
                     <p className="text-xs font-bold text-slate-700 dark:text-emerald-100/80 uppercase">Add Documents</p>
                     <p className="text-[10px] text-slate-600 dark:text-emerald-300/60 font-semibold uppercase tracking-wider">PDF, DOCX, CSV, JSON, Images, Code</p>
                   </div>
                 </div>
               </div>

               {files && files.length > 0 && (
                 <div className="bg-slate-50 dark:bg-emerald-950/30 border border-slate-200 dark:border-emerald-500/15 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider">Staging Queue</span>
                      <button type="button" onClick={() => setFiles(null)} className="text-[10px] font-bold text-red-600 hover:underline uppercase">Clear All</button>
                    </div>
                    <div className="space-y-2 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                      {Array.from(files).map((f, i) => (
                        <div key={i} className="group/file bg-white dark:bg-emerald-900/20 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 flex items-center gap-3">
                          <FileText size={14} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                          <span className="text-[11px] font-semibold truncate flex-1 text-slate-700 dark:text-emerald-50/90">{f.name}</span>
                          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => {
                            const dt = new DataTransfer();
                            Array.from(files).forEach((file, index) => { if (index !== i) dt.items.add(file); });
                            setFiles(dt.files.length > 0 ? dt.files : null);
                          }} className="text-red-600 dark:text-red-400 opacity-80 hover:opacity-100 focus-visible:opacity-100 p-1 rounded"><Trash2 size={13} aria-hidden="true" /></button>
                        </div>
                      ))}
                    </div>
                 </div>
               )}

               <button type="submit" disabled={isUploading} className="w-full glossy-emerald text-white py-3.5 rounded-xl text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
                 {isUploading ? "Processing Documents..." : "Upload to Registry"}
               </button>
               <button
                 type="button"
                 onClick={() => setShowConnectorsModal(true)}
                 className="w-full py-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 hover:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] font-black uppercase tracking-[0.15em] flex items-center justify-center gap-2 transition-all"
               >
                 <Plug size={14} /> Enterprise Connectors (36)
               </button>
               {uploadStatus && <p className={cn("text-[10px] text-center font-bold p-2 rounded-xl border animate-in slide-in-from-bottom-2", uploadStatus.includes("Error") ? "text-red-500 bg-red-50 border-red-100" : "text-emerald-600 bg-emerald-50 border-emerald-100")}>{uploadStatus}</p>}
             </form>
          </section>

          {/* MODULE 2: ACTIVE LIBRARY */}
          {indexedDocuments.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center justify-between px-1">
                 <div className="flex items-center gap-2">
                   <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-emerald-400/50">Active Library</h3>
                 </div>
                 <span className="bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded-full text-[9px] font-black">{indexedDocuments.length} {indexedDocuments.length === 1 ? "DOCUMENT" : "DOCUMENTS"}</span>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto no-scrollbar pr-1">
                {indexedDocuments.map((doc) => (
                  <div key={doc.name} className={cn("group flex items-center gap-3 p-3 rounded-2xl border transition-all duration-300", doc.active ? "bg-white dark:bg-emerald-400/5 border-slate-200 dark:border-emerald-500/10 shadow-sm" : "bg-slate-100/40 dark:bg-black/20 border-transparent grayscale opacity-40")}>
                    <button type="button" onClick={() => toggleDoc(doc.name)} className={cn("shrink-0 transition-all transform active:scale-90", doc.active ? "text-emerald-500" : "text-slate-400")}>
                      {doc.active ? <CheckSquare size={18} fill="currentColor" className="fill-emerald-500/10" /> : <Square size={18} />}
                    </button>
                    <div className="flex-1 min-w-0"><p className="text-xs font-bold truncate text-slate-700 dark:text-emerald-50/90">{doc.name}</p></div>
                    <button type="button" onClick={() => removeDoc(doc.name)} className="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 rounded-xl transition-all text-slate-300"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* MODULE 3: SYSTEM CONFIGURATION */}
          <div className="pt-6 border-t border-slate-100 dark:border-emerald-500/10 space-y-6">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-emerald-400/50">System Configuration</h3>
              </div>
              <button type="button" onClick={() => setShowSettings(!showSettings)} className="text-emerald-600 dark:text-emerald-400 text-[10px] font-black tracking-tighter hover:bg-emerald-50 dark:hover:bg-emerald-500/5 px-2 py-1 rounded-lg transition-colors">
                {showSettings ? "HIDE" : "EXPAND"}
              </button>
            </div>

            {showSettings && (
              <div className="space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
                
                {/* 3.1 INFERENCE CONFIG */}
                <div className="bg-white/40 dark:bg-emerald-950/20 border border-slate-200 dark:border-emerald-500/10 rounded-2xl p-5 space-y-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60">Inference Provider</span>
                  </div>
                  
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Provider</label>
                      <select className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-black outline-none cursor-pointer hover:border-emerald-500/30 transition-colors", fieldErr(!config.provider))} value={config.provider || ""} onChange={(e) => updateProvider(e.target.value as any)}>
                        <option value="" disabled hidden>Please Select Provider</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI GPT</option>
                        <option value="anthropic">Anthropic Claude</option>
                        <option value="custom">Custom Local API</option>
                      </select>
                    </div>

                    {config.provider && (
                      <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Model ID</label>
                          <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.modelId))} placeholder={DEFAULT_CONFIGS[config.provider]?.modelId || ""} value={config.modelId || ""} onChange={(e) => setConfig({...config, modelId: e.target.value})} />
                        </div>

                        {config.provider === "custom" && (
                          <div className="space-y-1.5 animate-in fade-in zoom-in-95 duration-200">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Base URL</label>
                            <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.baseUrl))} placeholder="http://localhost:11434/v1" value={config.baseUrl || ""} onChange={(e) => setConfig({...config, baseUrl: e.target.value})} />
                          </div>
                        )}

                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">API Key</label>
                          <div className="relative group/key">
                            <input type="password" placeholder="" className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl pl-10 pr-3 py-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(config.provider !== "custom" && !config.apiKey))} value={config.apiKey || ""} onChange={(e) => setConfig({...config, apiKey: e.target.value})} />
                            <Key size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-emerald-500/40 group-focus-within/key:text-emerald-500 transition-colors" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 3.2 VECTOR INFRASTRUCTURE (EMBEDDINGS) */}
                <div className="bg-white/40 dark:bg-emerald-950/20 border border-slate-200 dark:border-emerald-500/10 rounded-2xl p-5 space-y-5 shadow-sm">
                   <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60">Vector Infrastructure</span>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Vector Store DB</label>
                      <select className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-black outline-none cursor-pointer hover:border-emerald-500/30 transition-colors" value={config.vectorStoreProvider || "chroma"} onChange={(e) => setConfig({ ...config, vectorStoreProvider: e.target.value as any })}>
                        <option value="chroma">ChromaDB (Local / Self-Hosted)</option>
                        <option value="qdrant">Qdrant (REST Cloud / Cluster)</option>
                        <option value="pinecone">Pinecone (Serverless Namespaces)</option>
                      </select>
                    </div>

                    {config.vectorStoreProvider && config.vectorStoreProvider !== "chroma" && (
                      <div className="space-y-3 p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/15 animate-in fade-in duration-200">
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-emerald-600/70 uppercase tracking-widest px-1">
                            {config.vectorStoreProvider === "pinecone" ? "Pinecone Index Host URL" : "Qdrant URL"}
                          </label>
                          <input className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none" placeholder={config.vectorStoreProvider === "pinecone" ? "https://idx-xxxx.svc.pinecone.io" : "https://xxxx.qdrant.io:6333"} value={config.vectorStoreUrl || ""} onChange={(e) => setConfig({ ...config, vectorStoreUrl: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] font-bold text-emerald-600/70 uppercase tracking-widest px-1">Vector DB API Key</label>
                          <input type="password" className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none" placeholder="Uses .env fallback if blank" value={config.vectorStoreApiKey || ""} onChange={(e) => setConfig({ ...config, vectorStoreApiKey: e.target.value })} />
                        </div>
                        {config.vectorStoreProvider === "qdrant" && (
                          <div className="space-y-1">
                            <label className="text-[9px] font-bold text-emerald-600/70 uppercase tracking-widest px-1">Collection Name</label>
                            <input className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none" placeholder="rag-chat" value={config.vectorStoreIndex || ""} onChange={(e) => setConfig({ ...config, vectorStoreIndex: e.target.value })} />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Embedding Provider</label>
                      <select className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-black outline-none cursor-pointer hover:border-emerald-500/30 transition-colors", fieldErr(!config.embeddingProvider))} value={config.embeddingProvider || ""} onChange={(e) => {
                        const prov = e.target.value as any;
                        setConfig({...config, embeddingProvider: prov, embeddingModelId: ""});
                      }}>
                        <option value="" disabled hidden>Please Select Embedding Provider</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI</option>
                        <option value="custom">Custom Local API</option>
                      </select>
                    </div>

                    {config.embeddingProvider && (
                      <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Embedding Model ID</label>
                          <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.embeddingModelId))} placeholder={DEFAULT_CONFIGS[config.embeddingProvider]?.embeddingModelId || ""} value={config.embeddingModelId || ""} onChange={(e) => setConfig({...config, embeddingModelId: e.target.value})} />
                        </div>

                        {config.embeddingProvider === "custom" && (
                          <div className="space-y-1.5 animate-in fade-in zoom-in-95 duration-200">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Embedding Base URL</label>
                            <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.embeddingBaseUrl))} placeholder="http://localhost:11434" value={config.embeddingBaseUrl || ""} onChange={(e) => setConfig({...config, embeddingBaseUrl: e.target.value})} />
                          </div>
                        )}

                        {config.embeddingProvider !== "custom" && (
                          <div className="space-y-3 pt-1">
                             <div className="flex items-center justify-between px-1">
                                <label className="text-[10px] font-black text-slate-400 dark:text-emerald-500/50 uppercase tracking-widest">Embedding Key</label>
                                <div className="flex bg-slate-100 dark:bg-emerald-900/40 p-0.5 rounded-lg border border-emerald-500/10 shadow-sm">
                                  {["main", "custom"].map((s) => (
                                    <button type="button" key={s} onClick={() => setConfig({...config, embeddingKeySource: s as any})} className={cn("px-2.5 py-1 text-[8px] font-black uppercase rounded-md transition-all", (config.embeddingKeySource || "main") === s ? "bg-emerald-500 text-white shadow-lg" : "text-emerald-500/40 hover:text-emerald-500")}>
                                      {s === "main" ? "Use Main" : "Key"}
                                    </button>
                                  ))}
                                </div>
                             </div>
                             {config.embeddingKeySource === "custom" && (
                               <div className="relative animate-in fade-in slide-in-from-top-1 duration-200">
                                 <input type="password" placeholder="" className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl pl-10 pr-3 py-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.embeddingApiKey))} value={config.embeddingApiKey || ""} onChange={(e) => setConfig({...config, embeddingApiKey: e.target.value})} />
                                 <Key size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-emerald-500/40" />
                               </div>
                             )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 3.3 RETRIEVAL & OPTIMIZATION */}
                <div className="bg-white/40 dark:bg-emerald-950/20 border border-slate-200 dark:border-emerald-500/10 rounded-2xl p-5 space-y-5 shadow-sm">
                   <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60">Retrieval Optimization</span>
                  </div>

                  <div className="space-y-5">
                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Reranking Engine</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Improve High Recall</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={!!config.useReranking} onChange={(e) => setConfig({...config, useReranking: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    {config.useReranking && (
                       <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200 p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-emerald-600/60 uppercase px-1 tracking-widest">Rerank Provider</label>
                            <select className={cn("w-full bg-white dark:bg-emerald-900/60 border border-emerald-500/10 rounded-xl p-3 text-xs font-black outline-none cursor-pointer", fieldErr(config.useReranking && !config.rerankProvider))} value={config.rerankProvider || ""} onChange={(e) => {
                              const prov = e.target.value as any;
                              setConfig({...config, rerankProvider: prov, rerankModelId: ""});
                            }}>
                              <option value="" disabled hidden>Please Select Rerank Provider</option>
                              <option value="default">Default (Smart Fallback)</option>
                              <option value="cohere">Cohere AI</option>
                              <option value="voyage">Voyage AI</option>
                              <option value="custom">Custom API</option>
                            </select>
                          </div>

                          {config.rerankProvider && config.rerankProvider !== "default" && (
                            <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                              <div className="space-y-1.5">
                                <label className="text-[10px] font-bold text-emerald-600/60 uppercase px-1 tracking-widest">Model ID</label>
                                <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.rerankModelId))} placeholder={config.rerankProvider ? (DEFAULT_CONFIGS[config.rerankProvider]?.rerankModelId || "") : ""} value={config.rerankModelId || ""} onChange={(e) => setConfig({...config, rerankModelId: e.target.value})} />
                              </div>

                              {config.rerankProvider === "custom" && (
                                <div className="space-y-1.5 animate-in fade-in zoom-in-95 duration-200">
                                  <label className="text-[10px] font-bold text-emerald-600/60 uppercase px-1 tracking-widest">Base URL</label>
                                  <input className={cn("w-full bg-white dark:bg-emerald-900/60 border border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(!config.rerankBaseUrl))} placeholder="http://localhost:11434/v1/rerank" value={config.rerankBaseUrl || ""} onChange={(e) => setConfig({...config, rerankBaseUrl: e.target.value})} />
                                </div>
                              )}

                              <div className="space-y-3 pt-1">
                                 <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                                   <label className="text-[10px] font-black text-emerald-600/60 uppercase tracking-widest">Rerank Key</label>
                                   <div className="flex bg-white dark:bg-emerald-900/40 p-0.5 rounded-lg border border-emerald-500/20 shadow-sm">
                                     {["main", "embedding", "custom"].map((s) => (
                                       <button type="button" key={s} onClick={() => setConfig({...config, rerankKeySource: s as any})} className={cn("px-1.5 py-1 text-[7px] font-black uppercase rounded-md transition-all", (config.rerankKeySource || "main") === s ? "bg-emerald-500 text-white" : "text-emerald-500/40 hover:text-emerald-500")}>
                                         {s.toUpperCase()}
                                       </button>
                                     ))}
                                   </div>
                                 </div>
                                 {config.rerankKeySource === "custom" && (
                                   <div className="relative animate-in fade-in slide-in-from-top-1 duration-200">
                                     <input type="password" placeholder="" className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl pl-10 pr-3 py-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(config.rerankProvider !== "custom" && !config.rerankApiKey))} value={config.rerankApiKey || ""} onChange={(e) => setConfig({...config, rerankApiKey: e.target.value})} />
                                     <Key size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-emerald-500/40" />
                                   </div>
                                 )}
                              </div>
                            </div>
                          )}
                       </div>
                    )}

                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Hybrid Search (BM25 + RRF)</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Dense + Exact Keywords</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={config.useHybridSearch !== false} onChange={(e) => setConfig({...config, useHybridSearch: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Query Rewriting</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Resolve &amp; Expand Intent</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={config.useQueryRewrite !== false} onChange={(e) => setConfig({...config, useQueryRewrite: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Agentic Multi-Hop RAG</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Decompose &amp; Corrective Hop</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={!!config.useAgenticRag} onChange={(e) => setConfig({...config, useAgenticRag: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Knowledge Graph (GraphRAG)</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Entity-Relation Traversal</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={!!config.useGraphRag} onChange={(e) => setConfig({...config, useGraphRag: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col">
                        <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Full Context (CAG)</span>
                        <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Bypass Vector Search</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={!!config.useCag} onChange={(e) => setConfig({...config, useCag: e.target.checked})} />
                        <div className="w-11 h-6 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                      </label>
                    </div>

                    {!config.useCag && (
                      <div className="grid grid-cols-2 gap-3 px-1">
                        <div className="space-y-1.5">
                          <label className="text-[9px] font-black text-slate-400 dark:text-emerald-500/50 uppercase tracking-widest">Top-K Context</label>
                          <input
                            type="number"
                            min={1}
                            max={12}
                            className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all"
                            value={config.topK ?? 5}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              setConfig({ ...config, topK: Number.isNaN(v) ? 5 : Math.min(12, Math.max(1, v)) });
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label className="text-[9px] font-black text-slate-400 dark:text-emerald-500/50 uppercase tracking-widest">Min Sim</label>
                            <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-400">{(config.similarityThreshold ?? 0.3).toFixed(2)}</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={0.9}
                            step={0.05}
                            className="w-full accent-emerald-500 cursor-pointer mt-2"
                            value={config.similarityThreshold ?? 0.3}
                            onChange={(e) => setConfig({ ...config, similarityThreshold: parseFloat(e.target.value) })}
                          />
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 pt-2">
                       <div className="flex items-center justify-between px-1">
                          <label className="text-[10px] font-black text-slate-400 dark:text-emerald-500/50 uppercase tracking-widest">Context Format</label>
                          <div className="flex bg-slate-100 dark:bg-emerald-900/40 p-0.5 rounded-lg border border-emerald-500/10 shadow-sm">
                            {["json", "toon"].map((f) => (
                              <button type="button" key={f} onClick={() => setConfig({...config, contextFormat: f as any})} className={cn("px-3 py-1 text-[8px] font-black uppercase rounded-md transition-all", (config.contextFormat || "toon") === f ? "bg-emerald-500 text-white shadow-lg" : "text-emerald-500/40 hover:text-emerald-500")}>
                                {f.toUpperCase()}
                              </button>
                            ))}
                          </div>
                       </div>
                       <p className="text-[9px] text-emerald-500/30 px-1 leading-tight italic">TOON optimization reduces token usage by ~40% for large documents.</p>
                    </div>
                  </div>
                </div>

                {/* 3.4 DISTRIBUTED STATE (REDIS) */}
                <div className="bg-white/40 dark:bg-emerald-950/20 border border-slate-200 dark:border-emerald-500/10 rounded-2xl p-5 space-y-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60">Distributed State</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer scale-90">
                      <input type="checkbox" className="sr-only peer" checked={!!config.useRedis} onChange={(e) => setConfig({...config, useRedis: e.target.checked})} />
                      <div className="w-10 h-5 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                    </label>
                  </div>
                  
                  {config.useRedis && (
                    <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Redis Provider</label>
                        <select className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-black outline-none cursor-pointer", fieldErr(!config.redisProvider))} value={config.redisProvider || ""} onChange={(e) => setConfig({...config, redisProvider: e.target.value as any})}>
                          <option value="" disabled hidden>Please Select Provider</option>
                          <option value="upstash">Upstash (REST)</option>
                          <option value="standard">Standard (TCP)</option>
                        </select>
                      </div>

                      {config.redisProvider && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase px-1 tracking-widest">
                              {config.redisProvider === "standard" ? "Connection Host" : "Upstash URL"}
                            </label>
                            <input type="text" placeholder={config.redisProvider === "standard" ? "localhost or 127.0.0.1" : "https://..."} className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(config.redisProvider === "standard" ? !config.redisHost : !config.redisUrl))} value={config.redisProvider === "standard" ? (config.redisHost || "") : (config.redisUrl || "")} onChange={(e) => config.redisProvider === "standard" ? setConfig({...config, redisHost: e.target.value}) : setConfig({...config, redisUrl: e.target.value})} />
                          </div>

                          {config.redisProvider === "standard" && (
                            <div className="flex gap-3">
                              <div className="flex-1 space-y-1.5">
                                <label className="text-[10px] font-bold text-slate-400 uppercase px-1 tracking-widest text-[9px]">Port</label>
                                <input type="number" className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all" value={config.redisPort ?? 6379} onChange={(e) => { const v = parseInt(e.target.value, 10); setConfig({...config, redisPort: Number.isNaN(v) ? 6379 : v}); }} />
                              </div>
                              <div className="flex-1 space-y-1.5">
                                <label className="text-[10px] font-bold text-slate-400 uppercase px-1 tracking-widest text-[9px]">DB Index</label>
                                <input type="number" min="0" max="15" className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all" value={config.redisDb ?? 0} onChange={(e) => { const v = parseInt(e.target.value, 10); setConfig({...config, redisDb: Number.isNaN(v) ? 0 : v}); }} />
                              </div>
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase px-1 tracking-widest">
                              {config.redisProvider === "standard" ? "Password" : "Rest Token"}
                            </label>
                            <input type="password" placeholder="" className={cn("w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all", fieldErr(config.redisProvider === "upstash" && !config.redisToken))} value={config.redisProvider === "standard" ? (config.redisPassword || "") : (config.redisToken || "")} onChange={(e) => config.redisProvider === "standard" ? setConfig({...config, redisPassword: e.target.value}) : setConfig({...config, redisToken: e.target.value})} />
                          </div>

                          {config.redisProvider === "standard" && (
                            <div className="flex items-center justify-between px-1 py-1">
                              <div className="flex items-center gap-2">
                                <Lock size={12} className="text-emerald-500/60" />
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">TLS / SSL</span>
                              </div>
                              <label className="relative inline-flex items-center cursor-pointer scale-75">
                                <input type="checkbox" className="sr-only peer" checked={!!config.redisTls} onChange={(e) => setConfig({...config, redisTls: e.target.checked})} />
                                <div className="w-10 h-5 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                              </label>
                            </div>
                          )}

                          <div className="flex gap-3 pt-1">
                            <div className="flex-1 space-y-1.5">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase px-1 tracking-widest">Limit TTL (s)</label>
                              <input type="number" min="1" className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all" value={config.redisRateLimitTtl ?? 60} onChange={(e) => { const v = parseInt(e.target.value, 10); setConfig({...config, redisRateLimitTtl: Number.isNaN(v) ? 60 : v}); }} />
                            </div>
                            <div className="flex-1 space-y-1.5">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase px-1 tracking-widest">Cache TTL (s)</label>
                              <input type="number" min="60" className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all" value={config.redisCacheTtl ?? 3600} onChange={(e) => { const v = parseInt(e.target.value, 10); setConfig({...config, redisCacheTtl: Number.isNaN(v) ? 3600 : v}); }} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 3.5 ENTERPRISE GOVERNANCE & RBAC */}
                <div className="bg-white/40 dark:bg-emerald-950/20 border border-slate-200 dark:border-emerald-500/10 rounded-2xl p-5 space-y-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600/60">Enterprise Governance</span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Tenant Namespace</label>
                    <input
                      className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all"
                      placeholder="default"
                      value={config.tenantId || "default"}
                      onChange={(e) => setConfig({ ...config, tenantId: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") || "default" })}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-emerald-500/40 uppercase tracking-widest px-1">Active User Roles (RBAC)</label>
                    <input
                      className="w-full bg-white dark:bg-emerald-900/60 border border-slate-200 dark:border-emerald-500/10 rounded-xl p-2.5 text-xs font-semibold outline-none focus:ring-2 focus:ring-emerald-500/10 transition-all"
                      placeholder="member, engineering"
                      value={rolesInput}
                      onChange={(e) => {
                        setRolesInput(e.target.value);
                        const parsedRoles = e.target.value.split(",").map(r => r.trim()).filter(Boolean);
                        setConfig({ ...config, userRoles: parsedRoles.length > 0 ? parsedRoles : ["member"] });
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between px-1">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">PII Redaction</span>
                      <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Mask Emails, Phones, Cards</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer scale-90">
                      <input type="checkbox" className="sr-only peer" checked={!!config.enablePiiRedaction} onChange={(e) => setConfig({ ...config, enablePiiRedaction: e.target.checked })} />
                      <div className="w-10 h-5 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                    </label>
                  </div>

                  <div className="flex items-center justify-between px-1">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-black text-slate-700 dark:text-emerald-50/90 tracking-tight">Structured Audit Log</span>
                      <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">Track Query &amp; Ingest Events</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer scale-90">
                      <input type="checkbox" className="sr-only peer" checked={config.enableAuditLog !== false} onChange={(e) => setConfig({ ...config, enableAuditLog: e.target.checked })} />
                      <div className="w-10 h-5 bg-slate-200 rounded-full peer dark:bg-emerald-900/40 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                    </label>
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-t border-slate-200 dark:border-emerald-900/30 text-[10px] text-slate-600 dark:text-slate-400 font-bold flex items-center justify-between shrink-0 tracking-wider uppercase">
          <div className="flex items-center gap-2">
            <span
              aria-label={dbStatus === 'online' ? "Vector store online" : "Vector store offline"}
              className={cn(
              "w-2 h-2 rounded-full", 
              dbStatus === 'online' ? "bg-emerald-600" : "bg-red-600"
            )} />
            <a href="https://github.com/GaneshArwan" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository" className="hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">
              <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'text-bottom' }}>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
              </svg>
            </a>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 w-full flex flex-col relative bg-slate-50 dark:bg-[#020617]">
        <header className="h-16 bg-white dark:bg-[#0b1220] border-b border-slate-200 dark:border-emerald-500/15 flex items-center px-6 md:px-8 justify-between shrink-0 z-10">
          <div className="flex items-center gap-4">
            {!isSidebarOpen && (
              <button type="button" aria-label="Open sidebar" onClick={() => setIsSidebarOpen(true)} className="hover:bg-emerald-50 dark:hover:bg-emerald-500/10 p-2.5 rounded-xl text-emerald-700 dark:text-emerald-300 transition-colors bg-white dark:bg-emerald-950/30 border border-slate-200 dark:border-emerald-800/40">
                <PanelLeftOpen size={20} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowAuditModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-slate-100 dark:bg-emerald-950/40 border border-slate-200 dark:border-emerald-500/20 text-slate-700 dark:text-emerald-200 hover:border-emerald-500/50 transition-colors"
            >
              <Activity size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <span className="hidden sm:inline">Audit / API</span>
            </button>
            <div className="flex items-center gap-2.5 px-3.5 py-1.5 glass-emerald rounded-full">
               <div
                 aria-hidden="true"
                 className={cn(
                 "w-2 h-2 rounded-full", 
                 dbStatus === 'online' && isConfigComplete ? "bg-emerald-600" : "bg-red-600"
               )} />
               <span className="text-[11px] font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider">
                 {dbStatus === 'offline' ? "DB Offline" : (isConfigComplete ? "Verified" : "Sync Required")}
               </span>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-10 space-y-10 scroll-smooth no-scrollbar relative" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center space-y-5">
              <div className="p-6 bg-white dark:bg-emerald-950/30 rounded-2xl border border-slate-200 dark:border-emerald-500/15">
                <MessageSquare size={56} className="text-emerald-700/60 dark:text-emerald-400/60" aria-hidden="true" />
              </div>
              <div className="text-center space-y-1.5">
                <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Document Search</h2>
                <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 tracking-wider uppercase">Select your files and start a session</p>
              </div>
            </div>
          )}
          
          {messages.map((m: any) => (
            <div key={m.id} className={cn("flex gap-5 max-w-4xl mx-auto group animate-in slide-in-from-bottom-4 duration-500", m.role === "user" ? "flex-row-reverse" : "flex-row")}>
              <div className={cn(
                "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 font-black text-[10px] shadow-lg transition-transform duration-300 group-hover:scale-110", 
                m.role === "user" ? "glossy-emerald text-white" : "bg-white dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border border-slate-100 dark:border-emerald-800/30"
              )}>
                {m.role === "user" ? "USER" : "AI"}
              </div>
              <div className={cn(
                "flex-1 p-7 rounded-[2.5rem] text-[15px] leading-relaxed shadow-xl transition-all duration-300 group-hover:shadow-2xl", 
                m.role === "user" 
                  ? "glossy-emerald text-white rounded-tr-none" 
                  : "glass-emerald text-slate-800 dark:text-emerald-50/90 rounded-tl-none"
              )}>
                <div className={cn("prose prose-emerald prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-strong:font-black prose-code:p-1 prose-code:rounded", m.role === "user" ? "prose-p:text-white prose-strong:text-emerald-100 prose-code:bg-black/20 prose-code:text-white" : "prose-code:bg-emerald-500/10 prose-code:text-emerald-500")}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {getMessageContent(m)}
                  </ReactMarkdown>
                </div>
                
                {(() => {
                  const pipeline = getPipelineInfo(m);
                  const grounded = getGroundedness(m);
                  if (!pipeline || m.role === "user") return null;
                  return (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[9px] font-black uppercase tracking-wider">
                      <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                        {pipeline.mode}
                      </span>
                      {pipeline.vectorStore && (
                        <span className="px-2.5 py-1 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20">
                          {pipeline.vectorStore}
                        </span>
                      )}
                      {pipeline.wasRewritten && (
                        <span title={pipeline.rewrittenQuery || ""} className="px-2.5 py-1 rounded-full bg-teal-500/10 text-teal-700 dark:text-teal-300 border border-teal-500/20 cursor-help">
                          Query Rewritten
                        </span>
                      )}
                      {pipeline.reranked && (
                        <span className="px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
                          Reranked
                        </span>
                      )}
                      <span className="px-2.5 py-1 rounded-full bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/15">
                        {pipeline.finalCount} {pipeline.finalCount === 1 ? "Chunk" : "Chunks"}
                      </span>
                      {pipeline.hops > 1 && (
                        <span className="px-2.5 py-1 rounded-full bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/20">
                          {pipeline.hops} Hops
                        </span>
                      )}
                      {pipeline.graphHits > 0 && (
                        <span className="px-2.5 py-1 rounded-full bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20">
                          Graph {pipeline.graphHits}
                        </span>
                      )}
                      {pipeline.trace?.totalMs !== undefined && (
                        <span className="px-2.5 py-1 rounded-full bg-slate-500/10 text-slate-500 dark:text-slate-400 border border-slate-500/15">
                          {pipeline.trace.totalMs}ms
                        </span>
                      )}
                      {grounded && (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
                          Grounded {grounded.score}%
                        </span>
                      )}
                    </div>
                  );
                })()}

                {getSources(m) && (
                  <div className={cn("mt-6 pt-6 border-t", m.role === "user" ? "border-white/20" : "border-slate-100 dark:border-emerald-800/30")}>
                    <div className="flex items-center gap-2 mb-4">
                       <FileText size={16} className={m.role === "user" ? "text-white/60" : "text-emerald-600 dark:text-emerald-400"} />
                       <span className={cn("text-[10px] font-black uppercase tracking-[0.2em] opacity-50", m.role === "user" ? "text-white" : "text-emerald-600 dark:text-emerald-400")}>Evidence & Sources</span>
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      {(() => {
                        const sources = getSources(m);
                        if (!sources) return null;
                        const grouped = sources.reduce((acc: any, s: any, idx: number) => {
                          const num = s.id || idx + 1;
                          if (!acc[s.filename]) acc[s.filename] = { filename: s.filename, indices: [], snippets: [] };
                          acc[s.filename].indices.push(num);
                          acc[s.filename].snippets.push({ page: s.page, section: s.section, content: s.content, index: num });
                          return acc;
                        }, {});

                        return Object.values(grouped).map((group: any, gIdx: number) => (
                          <div key={gIdx} className={cn("group/source relative px-4 py-2 rounded-2xl border text-[10px] font-black transition-all cursor-help hover:-translate-y-0.5 shadow-sm", m.role === "user" ? "bg-white/10 border-white/20 text-white hover:bg-white/20" : "bg-emerald-50/50 dark:bg-emerald-500/5 border-emerald-100/50 dark:border-emerald-800/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/10")}>
                            <span className="opacity-70 mr-1.5 tracking-tighter">{group.indices.map((i: number) => `[${i}]`).join("")}</span>
                            {group.filename}
                            <div className="absolute bottom-full mb-3 left-0 w-80 max-h-96 overflow-y-auto no-scrollbar bg-white dark:bg-emerald-900 rounded-[2rem] shadow-2xl opacity-0 group-hover/source:opacity-100 pointer-events-none transition-all duration-300 border border-slate-100 dark:border-emerald-800 translate-y-2 group-hover/source:translate-y-0 z-50 p-1">
                              {group.snippets.map((snip: any, sIdx: number) => (
                                <div key={sIdx} className={cn("p-5 space-y-2", sIdx !== 0 && "border-t border-slate-100 dark:border-emerald-800/50")}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-emerald-500">
                                      <Shield size={10} />
                                      <span className="text-[9px] uppercase font-black tracking-widest">Evidence [{snip.index}]</span>
                                    </div>
                                    <span className="text-[8px] font-black text-slate-400 uppercase">Page: {snip.page}</span>
                                  </div>
                                  {snip.section && (
                                    <p className="text-[9px] font-black uppercase tracking-wider text-emerald-600/70 dark:text-emerald-300/70 truncate">
                                      {snip.section}
                                    </p>
                                  )}
                                  <p className="text-[11px] leading-relaxed font-bold italic line-clamp-4 text-slate-700 dark:text-emerald-50/90">&ldquo;{snip.content}&rdquo;</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          
          {isChatLoading && (
            <div className="flex gap-5 max-w-4xl mx-auto animate-in fade-in duration-500">
              <div className="w-10 h-10 rounded-2xl glass-emerald flex items-center justify-center">
                 <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <div className="flex-1 p-7 glass-emerald rounded-[2.5rem] rounded-tl-none italic text-emerald-600/60 dark:text-emerald-400/60 text-[13px] font-bold tracking-tight">
                Scanning context and generating response...
              </div>
            </div>
          )}
        </div>

        <div className="p-6 md:p-8 shrink-0 bg-slate-50 dark:bg-[#020617] border-t border-slate-200 dark:border-slate-800/80 z-10">
          <div className="max-w-4xl mx-auto">
            <form onSubmit={onChatSubmit} className="flex gap-3">
              <div className="flex-1">
                <input
                  aria-label="Ask a question about your indexed documents"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-emerald-500/25 rounded-2xl px-6 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 transition-colors font-medium text-sm placeholder:text-slate-500 dark:placeholder-slate-400 text-slate-900 dark:text-emerald-50"
                  value={localInput}
                  placeholder="Ask your document anything..."
                  disabled={isChatLoading}
                  onChange={(e) => setLocalInput(e.target.value)}
                />
              </div>
              <button
                type="submit"
                aria-label="Send message"
                disabled={isChatLoading || !localInput.trim()}
                className="glossy-emerald text-white px-7 rounded-2xl disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-emerald-900/30 flex items-center justify-center transition-colors"
              >
                <Send size={20} aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      </main>

      {/* DELETE CONFIRMATION MODAL */}
      {deleteConfirm && (
        <div role="dialog" aria-modal="true" aria-label="Confirm document deletion" className="fixed inset-0 z-[200] flex items-center justify-center p-6">
           <div className="absolute inset-0 bg-slate-950/60" onClick={() => setDeleteConfirm(null)} />
           <div className="relative w-full max-w-md bg-white dark:bg-[#06151c] border border-slate-200 dark:border-emerald-500/25 rounded-2xl p-8 shadow-xl">
              <div className="flex flex-col items-center text-center space-y-6">
                 <div className="w-14 h-14 bg-red-50 dark:bg-red-500/10 rounded-xl flex items-center justify-center text-red-600" aria-hidden="true">
                    <Trash2 size={28} />
                 </div>
                 <div className="space-y-2">
                    <h3 className="text-xl font-bold tracking-tight text-slate-900 dark:text-emerald-50">Confirm Document Deletion</h3>
                    <p className="text-sm text-slate-600 dark:text-emerald-200/80 font-medium px-2">
                       Are you sure you want to permanently remove <span className="font-bold text-slate-900 dark:text-emerald-300">&ldquo;{deleteConfirm}&rdquo;</span> from your vector data repository?
                    </p>
                 </div>
                 <div className="flex gap-3 w-full pt-2">
                    <button type="button" onClick={() => setDeleteConfirm(null)} className="flex-1 py-3.5 rounded-xl bg-slate-100 dark:bg-emerald-950/40 text-slate-700 dark:text-emerald-200 text-xs font-bold uppercase tracking-wider hover:bg-slate-200 dark:hover:bg-emerald-950/60 transition-colors">
                       Cancel
                    </button>
                    <button type="button" onClick={confirmDelete} className="flex-1 py-3.5 rounded-xl bg-red-600 text-white text-xs font-bold uppercase tracking-wider hover:bg-red-700 transition-colors">
                       Delete Document
                    </button>
                 </div>
              </div>
           </div>
        </div>
      )}
      <ConnectorsHubModal
        isOpen={showConnectorsModal}
        onClose={() => setShowConnectorsModal(false)}
        config={config}
        isConfigComplete={isConfigComplete}
        onNotify={(message, type) => setNotification({ message, type })}
        onSyncSuccess={(syncedFiles, message) => {
          setIndexedDocuments(prev => {
            const updated = [...prev];
            syncedFiles.forEach(name => {
              if (!updated.find(d => d.name === name)) updated.push({ name, active: true });
            });
            return updated;
          });
          setNotification({ message, type: 'success' });
        }}
      />

      <AuditApiModal
        isOpen={showAuditModal}
        onClose={() => setShowAuditModal(false)}
        config={config}
      />
    </div>
  );
}
