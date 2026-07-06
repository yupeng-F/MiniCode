"""轻量 Act 模式测试：请求系统列出项目文件。"""
import json
import requests

BASE = "http://127.0.0.1:8080"

# 1. 提交任务
resp = requests.post(f"{BASE}/api/run", json={
    "input": "列出项目根目录有哪些文件和文件夹",
    "mode": "act",
})
data = resp.json()
thread_id = data["thread_id"]
print(f"Thread ID: {thread_id}")

# 2. 流式读取结果
print("\n--- 流式输出 ---")
with requests.get(f"{BASE}/api/stream/{thread_id}", stream=True) as r:
    for line in r.iter_lines():
        if line and line.startswith(b"data: "):
            event = json.loads(line[6:])
            t = event.get("type", "")
            if t == "state":
                s = event.get("data", {})
                agent = s.get("agent", "")
                stage = s.get("stage", "")
                if stage or agent:
                    print(f"  [{agent}] {stage}")
                if s.get("final_answer"):
                    print(f"\n最终回答:\n{s['final_answer']}")
            elif t == "interrupt":
                print(f"\n⚡ 需要审批: {event['data']}")
            elif t == "done":
                print("\n✅ 完成")
                break
            elif t == "error":
                print(f"\n❌ 错误: {event['data']}")
                break

# 3. 查看最终状态
resp = requests.get(f"{BASE}/api/state/{thread_id}")
state = resp.json().get("state", {})
print(f"\n--- 最终状态 ---")
print(f"  status: {state.get('status')}")
print(f"  stage:  {state.get('stage')}")
print(f"  agent:  {state.get('agent')}")
print(f"  plan:   {state.get('plan', [])}")
print(f"  trace:  {len(state.get('trace_events', []))} 条事件")
