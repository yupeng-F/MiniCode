"""一键测试：启动服务器 → 提交 act 任务 → 流式输出结果。"""
import json
import threading
import time
import requests
import uvicorn
from multi_agents.interfaces.web.server import app

SERVER_PORT = 8081  # 避免和可能已运行的冲突

# ── 启动服务器 ──
def run_server():
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, log_level="warning")

t = threading.Thread(target=run_server, daemon=True)
t.start()
time.sleep(2)

print(f"Server started on http://127.0.0.1:{SERVER_PORT}\n")

# ── 提交任务 ──
resp = requests.post(f"http://127.0.0.1:{SERVER_PORT}/api/run", json={
    "input": "列出项目根目录有哪些文件和文件夹",
    "mode": "act",
})
data = resp.json()
tid = data["thread_id"]
print(f"Thread: {tid}\n")

# ── 流式读结果 ──
with requests.get(f"http://127.0.0.1:{SERVER_PORT}/api/stream/{tid}", stream=True) as r:
    for line in r.iter_lines():
        if line and line.startswith(b"data: "):
            event = json.loads(line[6:])
            t = event.get("type", "")
            if t == "state":
                s = event.get("data", {})
                agent = s.get("agent", "")
                stage = s.get("stage", "")
                if agent or stage:
                    print(f"  [{agent}] {stage}")
                msg = s.get("messages", [])
                if msg:
                    last = msg[-1]
                    if last.get("role") not in ("user",) and last.get("content"):
                        print(f"  💬 {last['role']}: {last['content'][:120]}")
                if s.get("final_answer"):
                    print(f"\n✅ 最终回答:\n{s['final_answer']}")
            elif t == "interrupt":
                print(f"\n⚡ 审批: {event['data']}")
            elif t == "done":
                print("\n✅ 任务完成")
                break
            elif t == "error":
                print(f"\n❌ {event['data']}")
                break

# ── 最终状态摘要 ──
state = requests.get(f"http://127.0.0.1:{SERVER_PORT}/api/state/{tid}").json().get("state", {})
print(f"\n--- 统计 ---")
print(f"  Trace 事件: {len(state.get('trace_events', []))} 条")
print(f"  工具调用:  {len(state.get('tool_results', []))} 次")
print(f"  Agent 记录: {len(state.get('messages', []))} 条")
