/* ── State ─────────────────────────────────────────── */
let currentThreadId = null;
let sse = null;
let pollTimer = null;
let knownMessages = new Set();
let _lastCompletedThread = null;  // 用于多轮延续

/* ── Activity Bar ────────────────────────────────── */
document.querySelectorAll('.action-btn[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    document.querySelectorAll('.action-btn[data-panel]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('chat-panel').style.display = panel === 'chat' ? 'flex' : 'none';
    document.getElementById('debug-panel').style.display = panel === 'debug' ? 'flex' : 'none';
    document.getElementById('settings-panel').style.display = panel === 'settings' ? 'flex' : 'none';
    if (panel === 'settings') {
      loadWorkspaceInfo();
      loadHistory();
    }
  });
});

/* ── Debug Tabs ──────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.debug-view').forEach(v => v.classList.remove('active'));
    document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
  });
});

/* ── New Task Dialog ─────────────────────────────── */
document.getElementById('new-task-btn').addEventListener('click', () => {
  document.getElementById('dialog-overlay').classList.remove('hidden');
});

document.getElementById('dialog-cancel').addEventListener('click', () => {
  document.getElementById('dialog-overlay').classList.add('hidden');
});

document.getElementById('dialog-start').addEventListener('click', startTaskFromDialog);

document.getElementById('dialog-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) startTaskFromDialog();
});

/* ── Send from input box ─────────────────────────── */
document.getElementById('send-btn').addEventListener('click', startTaskFromInput);
document.getElementById('input-box').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) startTaskFromInput();
});

/* ── Start Task ──────────────────────────────────── */
async function startTaskFromDialog() {
  const input = document.getElementById('dialog-input').value.trim();
  const mode = document.getElementById('mode-select').value;
  if (!input) return;
  document.getElementById('dialog-overlay').classList.add('hidden');
  document.getElementById('dialog-input').value = '';
  _lastCompletedThread = null;  // 新对话，不延续
  await startRun(input, mode);
}

async function startTaskFromInput() {
  const input = document.getElementById('input-box').value.trim();
  if (!input) return;
  document.getElementById('input-box').value = '';

  if (_lastCompletedThread) {
    await continueRun(_lastCompletedThread, input, 'act');
  } else {
    await startRun(input, 'act');
  }
}

async function startRun(input, mode) {
  knownMessages = new Set();
  _toolGroupEl = null;
  _toolGroupBody = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  showCancelButton(true);

  setStatus('正在提交...');
  setAgent('');
  addMessage('user', 'User', input);

  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const { thread_id } = await resp.json();
    currentThreadId = thread_id;
    addMessage('system', 'System', `任务已提交（ID: ${thread_id}），正在执行...`);
    connectSSE(thread_id);
    startPolling(thread_id);
  } catch (err) {
    addMessage('error', 'System', `启动失败: ${err.message}`);
    setStatus('Error');
    setAgent('');
  }
}

async function continueRun(threadId, input, mode) {
  knownMessages = new Set();
  _toolGroupEl = null;
  _toolGroupBody = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  showCancelButton(true);

  setStatus('延续对话...');
  addMessage('user', 'User', input);

  try {
    const resp = await fetch(`/api/chat/${threadId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    currentThreadId = data.thread_id;
    addMessage('system', 'System', `延续对话（${data.thread_id}），正在执行...`);
    connectSSE(data.thread_id);
    startPolling(data.thread_id);
  } catch (err) {
    addMessage('error', 'System', `延续失败: ${err.message}`);
    setStatus('Error');
    setAgent('');
  }
}

/* ── SSE ─────────────────────────────────────────── */
function connectSSE(threadId) {
  if (sse) { sse.close(); }

  sse = new EventSource(`/api/stream/${threadId}`);
  sse.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleEvent(msg);
    } catch { /* ignore */ }
  };
  sse.onerror = () => { /* browser auto-reconnects */ };
}

function handleEvent(event) {
  switch (event.type) {
    case 'state':
      updateFromState(event.data);
      break;
    case 'interrupt':
      showApprovalDialog(currentThreadId, event.data);
      setStatus('等待审批');
      break;
    case 'done':
      setStatus('已完成');
      setAgent('');
      closeApprovalDialog();
      showCancelButton(false);
      _lastCompletedThread = currentThreadId;  // 可延续
      if (sse) { sse.close(); sse = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      fetchState(currentThreadId);
      loadHistory(); // 刷新历史
      break;
    case 'error':
      addMessage('error', 'System', event.data || '未知错误');
      setStatus('失败');
      setAgent('');
      closeApprovalDialog();
      showCancelButton(false);
      if (sse) { sse.close(); sse = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      loadHistory();
      break;
  }
}

/* ── 轮询兜底 ────────────────────────────────────── */
function startPolling(threadId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => fetchState(threadId), 3000);
}

async function fetchState(threadId) {
  try {
    const resp = await fetch(`/api/state/${threadId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.state && data.state.stage) {
      updateFromState(data.state);
    }
    if (data.status === 'completed' || data.status === 'failed') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      setStatus(data.status === 'completed' ? '已完成' : '失败');
      setAgent('');
    }
  } catch { /* ignore */ }
}

/* ── Update UI from State ────────────────────────── */
function updateFromState(state) {
  if (!state) return;

  const status = state.status || '';
  if (status === 'completed') {
    setStatus('已完成');
    setAgentIndicator('completed', '✓ Done', '');
  } else if (status === 'failed') {
    setStatus('失败');
    setAgentIndicator('error', '✗ Failed', '');
  } else if (status === 'running' || status === 'pending') {
    const stage = state.stage || state.current_stage || '';
    setStatus(stage ? `${stage}` : '执行中');
    const agentName = state.agent || state.current_agent || '';
    const label = agentName ? agentLabel(agentName) : 'Running';
    setAgentIndicator(agentName, label, stage);
  }

  const agentEl = document.getElementById('status-agent');
  if (state.agent || state.current_agent) {
    setAgent(state.agent || state.current_agent || '');
  }

  // Messages dedup
  if (state.messages && state.messages.length > 0) {
    const last = state.messages[state.messages.length - 1];
    if (last.role !== 'user' && last.content) {
      const key = `msg:${last.role}:${last.content.slice(0, 80)}`;
      if (!knownMessages.has(key)) {
        knownMessages.add(key);
        addMessage('agent', last.role, last.content);
      }
    }
  }

  // Tool results grouping
  if (state.tool_results && state.tool_results.length > 0) {
    const lastTool = state.tool_results[state.tool_results.length - 1];
    if (lastTool && lastTool.tool) {
      const key = `tool:${lastTool.tool}:${(lastTool.summary || '').slice(0, 60)}`;
      if (!knownMessages.has(key)) {
        knownMessages.add(key);
        addToolResult(lastTool.tool, lastTool.success, lastTool.summary, lastTool.duration_ms, lastTool.stdout_preview || '');
      }
    }
  }

  // Debug: State
  document.getElementById('state-tab').textContent = JSON.stringify(state, null, 2);

  // Debug: Plan
  const planList = document.getElementById('plan-tab');
  planList.innerHTML = '';
  (state.plan || []).forEach(step => {
    const li = document.createElement('li');
    li.textContent = step;
    planList.appendChild(li);
  });

  // Debug: Tools
  const toolsDiv = document.getElementById('tools-tab');
  toolsDiv.innerHTML = '';
  (state.tool_results || []).forEach(t => {
    const item = document.createElement('div');
    item.className = 'tool-item';
    const ok = t.success ? 'ok' : 'fail';
    item.innerHTML = `<span class="${ok}">${t.success ? '✓' : '✗'}</span> ${t.tool || '?'} – ${t.summary || ''} <span class="time">${t.duration_ms || 0}ms</span>`;
    toolsDiv.appendChild(item);
  });

  // Debug: Memory
  const memDiv = document.getElementById('memory-tab');
  memDiv.innerHTML = '';
  const refs = state.memory_refs || [];
  if (refs.length > 0) {
    memDiv.innerHTML = '<div class="key">Memory refs:</div>\n' + refs.map(r => `  <span class="string">"${r}"</span>`).join('\n');
  } else {
    memDiv.textContent = '(no memory refs yet)';
  }

  // Debug: Trace
  const traceDiv = document.getElementById('trace-tab');
  traceDiv.innerHTML = '';
  const traces = state.trace_events || [];
  if (traces.length > 0) {
    traces.forEach(t => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      const icon = traceIcon(t.type || '');
      const time = t.ms > 0 ? ` <span class="time">${t.ms}ms</span>` : '';
      item.innerHTML = `<span class="trace-icon">${icon}</span> <span class="trace-agent">${escapeHtml(t.agent || '')}</span> <span class="trace-summary">${escapeHtml(t.summary || '')}</span>${time} <span class="trace-ts">${t.ts || ''}</span>`;
      traceDiv.appendChild(item);
    });
  } else {
    traceDiv.textContent = '(no trace events yet)';
  }

  // Final answer
  if (state.final_answer) {
    const key = `final:${state.final_answer.slice(0, 80)}`;
    if (!knownMessages.has(key)) {
      knownMessages.add(key);
      addMessage('agent', 'System', `**结果:** ${state.final_answer}`);
    }
  }
}

/* ── 工作空间 ─────────────────────────────────────── */

async function loadWorkspaceInfo() {
  try {
    const resp = await fetch('/api/workspace');
    const data = await resp.json();
    document.getElementById('workspace-path').textContent = data.path;
    document.getElementById('status-workspace').textContent = data.path;
  } catch {
    document.getElementById('workspace-path').textContent = '加载失败';
  }
}

// Workspace Browser
document.getElementById('workspace-change-btn').addEventListener('click', openBrowser);

document.getElementById('browser-cancel').addEventListener('click', () => {
  document.getElementById('browser-overlay').classList.add('hidden');
});

document.getElementById('browser-select').addEventListener('click', async () => {
  const path = document.getElementById('browser-current-path').textContent;
  await setWorkspace(path);
  document.getElementById('browser-overlay').classList.add('hidden');
});

document.getElementById('browser-go-btn').addEventListener('click', () => {
  const path = document.getElementById('browser-input').value.trim();
  if (path) browseDir(path);
});

document.getElementById('browser-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const path = document.getElementById('browser-input').value.trim();
    if (path) browseDir(path);
  }
});

async function openBrowser() {
  document.getElementById('browser-overlay').classList.remove('hidden');
  await browseDir('');
}

async function browseDir(path) {
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  try {
    const resp = await fetch(`/api/workspace/browse${params}`);
    const data = await resp.json();
    document.getElementById('browser-current-path').textContent = data.path;

    const list = document.getElementById('browser-list');
    list.innerHTML = '';

    // Parent dir
    if (data.parent && data.path !== data.parent) {
      const up = document.createElement('div');
      up.className = 'browser-item';
      up.innerHTML = '<span class="up-icon">📁</span> ..';
      up.addEventListener('click', () => browseDir(data.parent));
      list.appendChild(up);
    }

    data.entries.forEach(e => {
      const item = document.createElement('div');
      item.className = 'browser-item';
      if (e.is_dir) {
        item.innerHTML = `<span class="dir-icon">📁</span> ${e.name}`;
        item.addEventListener('click', () => browseDir(`${data.path}/${e.name}`));
      } else {
        item.innerHTML = `<span class="file-icon">📄</span> ${e.name}`;
      }
      list.appendChild(item);
    });
  } catch (err) {
    document.getElementById('browser-list').innerHTML = `<div class="history-empty">加载失败: ${err.message}</div>`;
  }
}

async function setWorkspace(path) {
  try {
    const resp = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    await loadWorkspaceInfo();
    addMessage('system', 'System', `工作空间已切换到: ${path}`);
  } catch (err) {
    addMessage('error', 'System', `切换工作空间失败: ${err.message}`);
  }
}

/* ── 历史记录 ─────────────────────────────────────── */

document.getElementById('history-refresh-btn').addEventListener('click', loadHistory);
document.getElementById('history-clear-btn').addEventListener('click', clearHistory);

async function loadHistory() {
  try {
    const resp = await fetch('/api/history');
    const data = await resp.json();
    renderHistory(data.persisted || []);
  } catch {
    document.getElementById('history-list').innerHTML = '<div class="history-empty">加载失败</div>';
  }
}

function renderHistory(entries) {
  const list = document.getElementById('history-list');
  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="history-empty">暂无历史记录</div>';
    return;
  }
  list.innerHTML = '';
  entries.forEach(e => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const statusClass = e.status === 'completed' ? 'completed' : 'failed';
    const statusText = e.status === 'completed' ? '✓ 完成' : '✗ 失败';
    item.innerHTML = `
      <span class="h-task">${escapeHtml(e.task || '?')}</span>
      <span class="h-status ${statusClass}">${statusText}</span>
      <span class="h-time">${e.timestamp || ''}</span>
    `;
    // Click to show final answer
    if (e.final_answer) {
      item.title = e.final_answer;
      item.addEventListener('click', () => {
        addMessage('system', 'History', `[${e.timestamp}] ${e.task}: ${e.final_answer}`);
        // Switch to chat panel
        document.querySelector('[data-panel="chat"]').click();
      });
    }
    list.appendChild(item);
  });
}

async function clearHistory() {
  if (!confirm('确定清除所有历史记录？')) return;
  try {
    await fetch('/api/history/clear', { method: 'POST' });
    loadHistory();
    addMessage('system', 'System', '历史记录已清除');
  } catch {
    addMessage('error', 'System', '清除历史失败');
  }
}

/* ── Helpers ─────────────────────────────────────── */

// 配置 marked 使用 highlight.js
if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      try { return hljs.highlightAuto(code).value; } catch {}
      return code;
    }
  });
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined' && text) {
    return marked.parse(text);
  }
  return escapeHtml(text);
}

function addMessage(role, name, content) {
  const container = document.getElementById('messages');

  // Round divider before user messages
  if (role === 'user') {
    const div = document.getElementById('last-round-divider');
    if (div) div.remove();
    const divider = document.createElement('div');
    divider.id = 'last-round-divider';
    divider.className = 'round-divider';
    divider.innerHTML = `<span>${new Date().toLocaleTimeString()}</span>`;
    container.appendChild(divider);
  }

  const msg = document.createElement('div');
  msg.className = `msg ${role}`;

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span class="agent-name">${escapeHtml(name)}</span><span>${new Date().toLocaleTimeString()}</span>`;

  const body = document.createElement('div');
  if (role === 'agent' || role === 'system') {
    body.className = 'msg-body markdown-body';
    body.innerHTML = renderMarkdown(content);
  } else {
    body.className = 'msg-body';
    body.textContent = content;
  }

  msg.appendChild(header);
  msg.appendChild(body);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// 工具结果分组：保留对分组元素的引用，增量更新
let _toolGroupEl = null;
let _toolGroupBody = null;

function addToolResult(toolName, success, summary, durationMs, stdoutPreview) {
  const container = document.getElementById('messages');

  // 首次：创建分组容器
  if (!_toolGroupEl) {
    _toolGroupEl = document.createElement('div');
    _toolGroupEl.className = 'tool-group';

    const toggle = document.createElement('div');
    toggle.className = 'tool-group-toggle';
    toggle.innerHTML = '<span class="toggle-icon">▾</span> Tool Results';
    toggle.addEventListener('click', () => {
      const body = _toolGroupEl.querySelector('.tool-group-body');
      const icon = toggle.querySelector('.toggle-icon');
      if (body.style.display === 'none') {
        body.style.display = 'block';
        icon.textContent = '▾';
      } else {
        body.style.display = 'none';
        icon.textContent = '▸';
      }
    });

    _toolGroupBody = document.createElement('div');
    _toolGroupBody.className = 'tool-group-body';

    _toolGroupEl.appendChild(toggle);
    _toolGroupEl.appendChild(_toolGroupBody);
    container.appendChild(_toolGroupEl);
  }

  // 追加一条工具结果
  const item = document.createElement('div');
  item.className = 'tool-result-item';
  const ok = success ? 'ok' : 'fail';
  const timeHtml = durationMs ? ` <span class="time">${durationMs}ms</span>` : '';
  item.innerHTML = `<span class="${ok}">${success ? '\u2713' : '\u2717'}</span> <span class="tool-name">${escapeHtml(toolName)}</span> \u2013 ${escapeHtml(summary || '')}${timeHtml}`;

  // 如果是 write_file 且有 diff 内容，追加 diff 视图
  if (toolName === 'write_file' && stdoutPreview && stdoutPreview.startsWith('---')) {
    const diffDiv = document.createElement('div');
    diffDiv.className = 'diff-view';
    stdoutPreview.split('\n').forEach(function(line) {
      var dline = document.createElement('div');
      dline.className = 'diff-line';
      if (line.startsWith('+')) {
        dline.className = 'diff-line diff-add';
        dline.textContent = line;
      } else if (line.startsWith('-')) {
        dline.className = 'diff-line diff-del';
        dline.textContent = line;
      } else if (line.startsWith('@@')) {
        dline.className = 'diff-line diff-hunk';
        dline.textContent = line;
      } else if (line.startsWith('---') || line.startsWith('+++')) {
        dline.className = 'diff-line diff-header';
        dline.textContent = line;
      } else {
        dline.textContent = line;
      }
      diffDiv.appendChild(dline);
    });
    item.appendChild(diffDiv);
  }

  _toolGroupBody.appendChild(item);

  container.scrollTop = container.scrollHeight;
}

function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

function setAgent(name) {
  document.getElementById('status-agent').textContent = name ? `Agent: ${name}` : '';
}

/* ── Cancel Button ────────────────────────────────── */
function showCancelButton(show) {
  const btn = document.getElementById('cancel-btn');
  if (btn) btn.style.display = show ? 'inline-block' : 'none';
}

document.getElementById('cancel-btn')?.addEventListener('click', async () => {
  if (!currentThreadId) return;
  try {
    await fetch(`/api/cancel/${currentThreadId}`, { method: 'POST' });
    addMessage('system', 'System', '任务已取消');
    setStatus('已取消');
    showCancelButton(false);
    if (sse) { sse.close(); sse = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } catch (err) {
    addMessage('error', 'System', `取消失败: ${err.message}`);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ── Agent Indicator ──────────────────────────────── */
const AGENT_COLORS = {
  master: '#0078d4',
  repo_explorer: '#4ec9b0',
  explorer: '#4ec9b0',
  coder: '#dcdcaa',
  reviewer: '#ce91d8',
  tester: '#cca700',
  memory_manager: '#6a9955',
  system: '#6e6e6e',
  completed: '#4ec9b0',
  error: '#f14c4c',
};

function agentLabel(name) {
  const labels = {
    master: 'Master',
    repo_explorer: 'Explorer',
    explorer: 'Explorer',
    coder: 'Coder',
    reviewer: 'Reviewer',
    tester: 'Tester',
    memory_manager: 'Memory',
    system: 'System',
  };
  return labels[name] || name;
}

function setAgentIndicator(agent, label, stage) {
  const badge = document.getElementById('agent-badge');
  const labelEl = document.getElementById('agent-label');
  const stageEl = document.getElementById('agent-stage');
  if (!badge) return;

  // Update class for animation
  badge.className = 'badge-' + (agent || 'idle');
  badge.style.color = AGENT_COLORS[agent] || AGENT_COLORS.system;

  labelEl.textContent = label || '';
  stageEl.textContent = stage ? `— ${stage}` : '';
}

function traceIcon(type) {
  switch (type) {
    case 'task_start': return '🚀';
    case 'task_end': return '✅';
    case 'agent_start': return '▶';
    case 'agent_end': return '◼';
    case 'tool_execution': return '🔧';
    case 'master_dispatch': return '➡';
    case 'approval': return '🔒';
    default: return '•';
  }
}

/* ── Approval Dialog ──────────────────────────────── */
function showApprovalDialog(threadId, ctx) {
  document.getElementById('ap-agent').textContent = ctx.agent_name || '?';
  document.getElementById('ap-tool').textContent = ctx.tool_name || '?';
  document.getElementById('ap-intent').textContent = ctx.intent_summary || '(no summary)';
  document.getElementById('ap-risk').textContent = ctx.risk_level || 'unknown';

  // 绑定按钮
  document.getElementById('ap-approve-btn').onclick = () => resumeWith(threadId, 'approved');
  document.getElementById('ap-reject-btn').onclick = () => resumeWith(threadId, 'rejected');

  document.getElementById('approval-overlay').classList.remove('hidden');
}

function closeApprovalDialog() {
  document.getElementById('approval-overlay').classList.add('hidden');
}

async function resumeWith(threadId, decision) {
  try {
    document.getElementById('ap-approve-btn').disabled = true;
    document.getElementById('ap-reject-btn').disabled = true;
    setStatus('正在恢复...');
    showCancelButton(false);

    const resp = await fetch(`/api/resume/${threadId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    addMessage('system', 'Approval', `→ ${decision === 'approved' ? '已批准' : '已拒绝'}`);
    closeApprovalDialog();
  } catch (err) {
    addMessage('error', 'System', `审批恢复失败: ${err.message}`);
    closeApprovalDialog();
  }
}

/* ── Keyboard shortcut ───────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) {
    if (!document.getElementById('dialog-overlay').classList.contains('hidden')) {
      startTaskFromDialog();
    } else {
      startTaskFromInput();
    }
  }
});

/* ── 初始化 ───────────────────────────────────────── */
loadWorkspaceInfo();
loadHistory();
