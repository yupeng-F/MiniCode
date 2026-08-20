export type Project = { project_id: string; workspace: string; title: string };
export type Session = { session_id: string; run_id: string; workspace: string; task: string; mode: string; model_id: string; run_model_id: string; status: string; messages: Message[]; tool_calls: ToolCall[]; active_files: string[]; plan: string[]; memory_refs: string[]; context_usage: Record<string, number>; context_dropped: string[]; final_answer: string };
export type SessionSummary = { session_id: string; project_id: string; title: string; status: string; model_id: string; updated_at: string };
export type Message = { role: string; content: string };
export type ToolCall = { tool_name: string; status: string; result?: { summary: string; preview: string } };
export type DirectoryEntry = { name: string; path: string; is_dir: boolean };
export type DirectoryListing = { path: string; parent: string; entries: DirectoryEntry[] };
export type FilePage = { path: string; content: string; offset: number; total_lines: number; next_offset: number | null };
export type MemoryRecord = { id: string; name: string; status: string; content: string; category: string; metadata: Record<string, string> };
export type ModelProfile = { id: string; label: string; provider: string; context_window: number; max_output_tokens: number };
export type Capabilities = { default_model: string; models: ModelProfile[]; token_limits: { input: number; output: number; user_message: number } };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error((await response.json()).detail || "Request failed");
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  capabilities: () => request<Capabilities>("/api/capabilities"),
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (workspace: string, title?: string) => request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ workspace, title }) }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  browseDirectories: (path?: string) => request<DirectoryListing>(`/api/filesystem/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  listFiles: (projectId: string, path = ".") => request<DirectoryListing>(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`),
  readFile: (projectId: string, path: string, offset = 0, limit = 400) => request<FilePage>(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`),
  listMemories: (projectId: string) => request<MemoryRecord[]>(`/api/projects/${projectId}/memories`),
  updateMemory: (projectId: string, memoryId: string, update: { name?: string; content?: string; paths?: string[]; enabled?: boolean }) => request<MemoryRecord>(`/api/projects/${projectId}/memories/${memoryId}`, { method: "PATCH", body: JSON.stringify(update) }),
  deleteMemory: (projectId: string, memoryId: string) => request<void>(`/api/projects/${projectId}/memories/${memoryId}`, { method: "DELETE" }),
  listSessions: (projectId: string) => request<SessionSummary[]>(`/api/projects/${projectId}/sessions`),
  createSession: (projectId: string, input: string, mode: string, modelId: string) => request<Session>(`/api/projects/${projectId}/sessions`, { method: "POST", body: JSON.stringify({ input, mode, model_id: modelId }) }),
  getSession: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}`),
  selectModel: (sessionId: string, modelId: string) => request<Session>(`/api/sessions/${sessionId}/model`, { method: "PATCH", body: JSON.stringify({ model_id: modelId }) }),
  deleteSession: (sessionId: string) => request<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
  run: (sessionId: string, input: string, mode: string) => request<{ run_id: string }>("/api/runs", { method: "POST", body: JSON.stringify({ session_id: sessionId, input, mode }) }),
  getRun: (runId: string) => request<Session>(`/api/runs/${runId}`),
  decide: (runId: string, decision: "approve" | "reject") => request(`/api/runs/${runId}/approval`, { method: "POST", body: JSON.stringify({ decision }) }),
};
