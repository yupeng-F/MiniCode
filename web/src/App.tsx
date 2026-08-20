import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, CirclePlus, FileCode2, Folder, FolderOpen, PanelRight, RefreshCw, Send, ShieldCheck, Terminal, Trash2, Wrench, X } from "lucide-react";
import { api, type Capabilities, type DirectoryEntry, type DirectoryListing, type FilePage, type MemoryRecord, type MemoryRetrievalStatus, type Message, type Project, type Session, type SessionSummary } from "./api";

const modes = ["ask", "plan", "act", "review"];
type ActiveRun = { runId: string; sessionId: string; projectId: string };
const lastProjectKey = "minicode.lastProject";
const lastSessionKey = "minicode.lastSession";

export function shouldRenderFinalAnswer(messages: Message[] | undefined, finalAnswer: string): boolean {
  if (!finalAnswer) return false;
  const lastMessage = messages?.[messages.length - 1];
  return lastMessage?.role !== "assistant" || lastMessage.content !== finalAnswer;
}

export function isActiveRunStatus(status: string): boolean {
  return ["pending", "running", "waiting_approval"].includes(status);
}

export function shouldSubmitComposer(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function estimateComposerTokens(content: string): number {
  if (!content) return 0;
  const cjkCount = (content.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const nonCjkCount = content.length - cjkCount;
  return Math.ceil((cjkCount + Math.ceil(nonCjkCount / 4)) * 1.1);
}

export function shouldResetConversation(currentWorkspace: string | undefined, nextWorkspace: string): boolean {
  return currentWorkspace !== undefined && currentWorkspace !== nextWorkspace;
}

export function embeddingStatusLabel(status?: Pick<MemoryRetrievalStatus, "provider" | "external_transfer" | "fallback_reason">): string {
  if (!status?.provider) return "";
  const reason = status.fallback_reason ? `（${status.fallback_reason}）` : "";
  if (status.provider === "aliyun") return `阿里云 embedding${status.external_transfer ? " · 内容已发送到阿里云" : ""}${reason}`;
  if (status.provider === "local") return `本地 embedding${reason}`;
  return `关键词检索${reason}`;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("act");
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [modelId, setModelId] = useState("deepseek-v4-flash");
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [error, setError] = useState("");
  const [contextTab, setContextTab] = useState("files");
  const [dialog, setDialog] = useState<"project" | "session" | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [browser, setBrowser] = useState<DirectoryListing | null>(null);
  const [fileTree, setFileTree] = useState<Record<string, DirectoryEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState("");
  const [filePage, setFilePage] = useState<FilePage | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const sessionRequest = useRef(0);
  const inputTokens = useMemo(() => estimateComposerTokens(input), [input]);
  const userMessageLimit = capabilities?.token_limits.user_message ?? 12_000;
  const inputOverLimit = inputTokens > userMessageLimit;

  const report = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const refreshProjects = async () => { try {
    const items = await api.listProjects();
    setProjects(items);
    setProject(current => current ?? items.find(item => item.project_id === window.localStorage.getItem(lastProjectKey)) ?? null);
    setError("");
  } catch (err) { report(err); } };
  const loadRoot = async (item: Project) => {
    try { setFileTree({ ".": (await api.listFiles(item.project_id)).entries }); setExpandedDirs(new Set(["."])); setSelectedFile(""); setFilePage(null); } catch (err) { report(err); }
  };

  useEffect(() => {
    void refreshProjects();
    void api.capabilities().then(result => {
      setCapabilities(result);
      setModelId(current => current || result.default_model);
    }).catch(report);
  }, []);
  useEffect(() => { if (project) { void api.listSessions(project.project_id).then(setSessions).catch(report); void loadRoot(project); } }, [project]);
  useEffect(() => { if (project && selectedFile) void api.readFile(project.project_id, selectedFile).then(setFilePage).catch(report); }, [project, selectedFile]);
  useEffect(() => { if (project && contextTab === "memory") void api.listMemories(project.project_id).then(setMemories).catch(report); }, [project, contextTab]);
  useEffect(() => {
    if (!activeRun) return;
    const syncRun = async () => {
      try {
        const latest = await api.getRun(activeRun.runId);
        setSession(current => current?.session_id === activeRun.sessionId ? latest : current);
        if (!isActiveRunStatus(latest.status)) {
          setActiveRun(current => current?.runId === activeRun.runId ? null : current);
          void api.listSessions(activeRun.projectId).then(items => {
            setSessions(current => project?.project_id === activeRun.projectId ? items : current);
          }).catch(report);
          if (project?.project_id === activeRun.projectId) void loadRoot(project);
        }
      } catch (err) {
        report(err);
      }
    };
    const stream = new EventSource(`/api/runs/${activeRun.runId}/stream`);
    stream.onmessage = () => { void syncRun(); };
    stream.onerror = () => stream.close();
    const timer = window.setInterval(() => { void syncRun(); }, 3_000);
    void syncRun();
    return () => { stream.close(); window.clearInterval(timer); };
  }, [activeRun, project]);

  const browse = async (path?: string) => { try { setBrowser(await api.browseDirectories(path)); } catch (err) { report(err); } };
  const showProjectPicker = () => { setDialog("project"); void browse(); };
  const openProject = async () => {
    if (!browser) return;
    try {
      const next = await api.createProject(browser.path);
      if (shouldResetConversation(project?.workspace, next.workspace)) {
        sessionRequest.current += 1;
        window.localStorage.removeItem(lastSessionKey);
        setSession(null);
        setSessions([]);
        setActiveRun(null);
      }
      setProject(next);
      setDialog(null);
      setBrowser(null);
      setError("");
      await refreshProjects();
    } catch (err) { report(err); }
  };
  const selectProject = (item: Project) => {
    sessionRequest.current += 1;
    window.localStorage.setItem(lastProjectKey, item.project_id);
    window.localStorage.removeItem(lastSessionKey);
    setActiveRun(null);
    setProject(item);
    setSession(null);
    setSessions([]);
  };
  const openSession = async (item: SessionSummary) => {
    const requestId = ++sessionRequest.current;
    setActiveRun(null);
    try {
      const next = await api.getSession(item.session_id);
      if (requestId !== sessionRequest.current) return;
      setSession(next);
      window.localStorage.setItem(lastSessionKey, next.session_id);
      setMode(next.mode);
      setModelId(next.model_id);
      if (isActiveRunStatus(next.status) && project) {
        setActiveRun({ runId: next.run_id, sessionId: next.session_id, projectId: project.project_id });
      }
    } catch (err) { report(err); }
  };
  const newSession = async () => {
    if (!project || !dialogValue.trim()) return;
    try { const next = await api.createSession(project.project_id, dialogValue.trim(), mode, modelId); sessionRequest.current += 1; setActiveRun(null); setSession(next); setModelId(next.model_id); setDialog(null); setDialogValue(""); setSessions(await api.listSessions(project.project_id)); } catch (err) { report(err); }
  };
  const run = async () => { if (!project || !session || !input.trim() || inputOverLimit) return; try { const result = await api.run(session.session_id, input.trim(), mode); setInput(""); setActiveRun({ runId: result.run_id, sessionId: session.session_id, projectId: project.project_id }); } catch (err) { report(err); } };
  const selectModel = async (nextModelId: string) => {
    if (activeRun) return;
    if (!session) { setModelId(nextModelId); return; }
    try {
      const next = await api.selectModel(session.session_id, nextModelId);
      setSession(next);
      setModelId(next.model_id);
    } catch (err) { report(err); }
  };
  const decide = async (decision: "approve" | "reject") => { if (activeRun) try { await api.decide(activeRun.runId, decision); setActiveRun(current => current ? { ...current } : current); } catch (err) { report(err); } };
  const deleteSession = async (item: SessionSummary) => {
    if (!window.confirm(`删除会话“${item.title}”？`)) return;
    try {
      await api.deleteSession(item.session_id);
      if (session?.session_id === item.session_id) { sessionRequest.current += 1; window.localStorage.removeItem(lastSessionKey); setSession(null); setActiveRun(null); }
      if (project) setSessions(await api.listSessions(project.project_id));
    } catch (err) { report(err); }
  };
  const deleteProject = async (item: Project) => {
    if (!window.confirm(`从历史记录移除项目“${item.title}”？电脑上的项目文件不会被删除。`)) return;
    try {
      await api.deleteProject(item.project_id);
      if (project?.project_id === item.project_id) { sessionRequest.current += 1; window.localStorage.removeItem(lastProjectKey); window.localStorage.removeItem(lastSessionKey); setProject(null); setSession(null); setSessions([]); setActiveRun(null); setFileTree({}); setSelectedFile(""); setFilePage(null); }
      await refreshProjects();
    } catch (err) { report(err); }
  };
  const toggleDirectory = async (path: string) => {
    const isOpen = expandedDirs.has(path);
    if (!isOpen && !fileTree[path] && project) { try { const listing = await api.listFiles(project.project_id, path); setFileTree(current => ({ ...current, [path]: listing.entries })); } catch (err) { report(err); return; } }
    setExpandedDirs(current => { const next = new Set(current); isOpen ? next.delete(path) : next.add(path); return next; });
  };
  const loadMore = async () => { if (!project || !filePage?.next_offset || !selectedFile) return; try { const next = await api.readFile(project.project_id, selectedFile, filePage.next_offset); setFilePage(current => current ? { ...next, content: `${current.content}\n${next.content}`, offset: current.offset, total_lines: next.total_lines } : next); } catch (err) { report(err); } };
  useEffect(() => {
    if (session || sessions.length === 0) return;
    const previous = window.localStorage.getItem(lastSessionKey);
    const match = sessions.find(item => item.session_id === previous);
    if (match) void openSession(match);
  }, [sessions, session]);
  const tools = useMemo(() => session?.tool_calls ?? [], [session]);
  const renderEntries = (parent: string, depth = 0) => (fileTree[parent] ?? []).map(entry => <div key={entry.path} className="tree-node" style={{ paddingLeft: `${10 + depth * 15}px` }}>
    {entry.is_dir ? <button className="tree-button" onClick={() => void toggleDirectory(entry.path)}>{expandedDirs.has(entry.path) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<Folder size={14}/><span>{entry.name}</span></button> : <button className={selectedFile === entry.path ? "tree-button selected-file" : "tree-button"} onClick={() => setSelectedFile(entry.path)}><span className="tree-spacer"/><FileCode2 size={14}/><span>{entry.name}</span></button>}
    {entry.is_dir && expandedDirs.has(entry.path) && renderEntries(entry.path, depth + 1)}
  </div>);

  return <main className="workspace">
    <aside className="sidebar">
      <header className="brand"><span className="brand-mark"><Bot size={17}/></span><span>MiniCode</span><button title="刷新项目" onClick={() => void refreshProjects()}><RefreshCw size={15}/></button></header>
      <div className="section-title"><span>项目</span><button title="选择本地项目" onClick={showProjectPicker}><FolderOpen size={15}/></button></div>
      <nav>{projects.map(item => <div className="nav-row" key={item.project_id}><button className={project?.project_id === item.project_id ? "nav-item selected" : "nav-item"} onClick={() => selectProject(item)}><span className="project-dot"/><span>{item.title}</span></button><button className="delete-action" title="移除项目记录" onClick={() => void deleteProject(item)}><Trash2 size={13}/></button></div>)}</nav>
      <div className="section-title"><span>会话</span><button title="新建会话" disabled={!project} onClick={() => { setDialogValue(""); setDialog("session"); }}><CirclePlus size={15}/></button></div>
      <nav>{sessions.map(item => <div className="nav-row" key={item.session_id}><button className={session?.session_id === item.session_id ? "nav-item selected" : "nav-item"} onClick={() => void openSession(item)}><span className="session-dot"/><span>{item.title}</span></button><button className="delete-action" title="删除会话" onClick={() => void deleteSession(item)}><Trash2 size={13}/></button></div>)}</nav>
    </aside>
    <section className="conversation">
      <header className="toolbar"><div><span className="status-light" data-running={Boolean(activeRun)}/>{session ? session.task : "选择项目并创建会话"}</div><select aria-label="选择模型" value={modelId} disabled={Boolean(activeRun)} onChange={event => void selectModel(event.target.value)}>{(capabilities?.models ?? [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（快速）" }]).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><select aria-label="选择模式" value={mode} onChange={event => setMode(event.target.value)}>{modes.map(item => <option key={item}>{item}</option>)}</select></header>
      <div className="timeline">
        {error && <div className="error"><X size={15}/><span>{error}</span><button title="关闭错误" onClick={() => setError("")}><X size={14}/></button></div>}
        {embeddingStatusLabel(session?.memory_retrieval) && <div className={`embedding-status ${session?.memory_retrieval?.provider ?? ""}`} role="status">{embeddingStatusLabel(session?.memory_retrieval)}</div>}
        {!session && <div className="empty-state"><Bot size={28}/><strong>从一个本地项目开始</strong><span>选择项目后创建会话</span></div>}
        {session?.messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "You" : "MiniCode"}</span><p>{message.content}</p></article>)}
        {tools.map((tool, index) => <details className="tool" key={`${tool.tool_name}-${index}`}><summary><Wrench size={14}/><span>{tool.tool_name}</span><em>{tool.status}</em></summary><pre>{tool.result?.preview || tool.result?.summary || "Waiting for approval"}</pre></details>)}
        {session?.status === "waiting_approval" && <div className="approval"><ShieldCheck size={18}/><span>该操作需要确认</span><button onClick={() => void decide("reject")}>拒绝</button><button className="primary" onClick={() => void decide("approve")}>批准</button></div>}
        {session && shouldRenderFinalAnswer(session.messages, session.final_answer) && <article className="message assistant"><span>MiniCode</span><p>{session.final_answer}</p></article>}
      </div>
      <footer className="composer"><div className="composer-input"><textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); void run(); } }} disabled={!session || Boolean(activeRun)} placeholder={session ? "描述下一步任务（Enter 发送，Shift+Enter 换行）" : "先创建会话"}/><small className={inputOverLimit ? "token-count over-limit" : "token-count"}>约 {inputTokens.toLocaleString()} / {userMessageLimit.toLocaleString()} tokens</small></div><button className="primary" title={inputOverLimit ? "输入超过 Token 上限" : "运行任务"} onClick={() => void run()} disabled={!session || !input.trim() || inputOverLimit || Boolean(activeRun)}><Send size={17}/></button></footer>
    </section>
    <aside className="context-panel">
      <header><PanelRight size={17}/><span>上下文</span></header>
      <div className="tabs">{[["files", "文件"], ["diff", "Diff"], ["plan", "计划"], ["output", "输出"], ["memory", "记忆"]].map(([key, label]) => <button className={contextTab === key ? "active" : ""} key={key} onClick={() => setContextTab(key)}>{label}</button>)}</div>
      <div className="context-body">
        {contextTab === "files" && <div className="file-workbench"><div className="file-tree">{project ? renderEntries(".") : <div className="empty">选择项目以浏览文件</div>}</div>{filePage && <div className="file-view"><div className="file-title"><FileCode2 size={14}/><span>{filePage.path}</span><em>{filePage.total_lines} 行</em></div><pre>{filePage.content.split("\n").map((line, index) => <code key={index}><i>{filePage.offset + index + 1}</i>{line || " "}</code>)}</pre>{filePage.next_offset !== null && <button className="load-more" onClick={() => void loadMore()}>加载后续内容</button>}</div>}</div>}
        {contextTab === "diff" && <div className="output-list">{tools.filter(tool => ["propose_patch", "apply_patch", "git_diff"].includes(tool.tool_name)).map((tool, index) => <pre key={index}>{tool.result?.preview || tool.result?.summary}</pre>)}</div>}
        {contextTab === "plan" && <div className="output-list">{session?.plan?.length ? session.plan.map((step, index) => <pre key={index}>{index + 1}. {step}</pre>) : <div className="empty">计划将在 plan 模式任务中显示</div>}</div>}
        {contextTab === "output" && <div className="output-list">{tools.length ? tools.map((tool, index) => <pre key={index}><Terminal size={13}/>{tool.result?.summary}</pre>) : <div className="empty">暂无运行输出</div>}</div>}
        {contextTab === "memory" && <div className="output-list">{memories.length ? memories.map(item => <pre key={item.id}><strong>{item.name}</strong> · {item.status}{"\n"}{item.content}{"\n"}<button onClick={() => project && void api.updateMemory(project.project_id, item.id, { enabled: false }).then(() => api.listMemories(project.project_id)).then(setMemories).catch(report)}>禁用</button> <button onClick={() => project && void api.deleteMemory(project.project_id, item.id).then(() => api.listMemories(project.project_id)).then(setMemories).catch(report)}>删除</button></pre>) : <div className="empty">暂无项目记忆</div>}</div>}
      </div>
    </aside>
    {dialog === "project" && <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}><section className="dialog directory-dialog" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><header><div><span>选择本地项目</span><small>{browser?.path}</small></div><button title="关闭" onClick={() => setDialog(null)}><X size={16}/></button></header><div className="directory-actions"><button disabled={!browser || browser.path === browser.parent} onClick={() => void browse(browser?.parent)}>上一级</button><button onClick={() => void browse(browser?.path)}>刷新</button></div><div className="directory-list">{browser?.entries.map(item => <button key={item.path} onClick={() => void browse(item.path)}><Folder size={16}/><span>{item.name}</span><ChevronRight size={15}/></button>)}</div><footer><button onClick={() => setDialog(null)}>取消</button><button className="primary" onClick={() => void openProject()}>选择当前文件夹</button></footer></section></div>}
    {dialog === "session" && <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}><section className="dialog" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><header><span>新建会话</span><button title="关闭" onClick={() => setDialog(null)}><X size={16}/></button></header><input autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} placeholder="描述要完成的任务" onKeyDown={event => { if (event.key === "Enter") void newSession(); }}/><footer><button onClick={() => setDialog(null)}>取消</button><button className="primary" onClick={() => void newSession()}>创建</button></footer></section></div>}
  </main>;
}
