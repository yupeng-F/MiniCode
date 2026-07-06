# MCP 与 GPTs 学习笔记

> 学习日期：2026-05-21 | 时长：约 45 分钟 | 平均掌握度：85%

---

## 一句话核心

**MCP = 标准 | GPTs = 产品**

MCP 定义"怎么连"，GPTs 解决"怎么用"。
二者不在同一层面，可以互补。

---

## 一、AI Agent 核心公式

```
Agent = LLM（大脑） + 工具（手脚） + 记忆 + 状态管理 + 权限控制
```

LLM 本身只是"大脑"，接了工具才能行动。但 N 个工具 × N 种协议 = 适配噩梦。

---

## 二、MCP（Model Context Protocol）

**开放协议**，由 Anthropic 提出。作用是统一 Agent 与工具之间的通信规范，相当于 AI 界的 **USB-C 接口**。

### 架构

```
Host（LLM 应用）→ Client（会话管理）↔ Server（工具服务）
```

- **Host**：Claude Desktop、VS Code、自定义 Agent 等
- **Client**：每个 Host 内置的连接管理器（会话管理、能力协商、认证授权）
- **Server**：暴露具体功能的轻量服务（文件系统、数据库、Web API 等）

### 传输方式

| 方式 | 说明 | 场景 |
|------|------|------|
| **stdio** | 通过 stdin/stdout 管道通信 | 本地进程间通信 |
| **SSE** | HTTP 长连接 | 远程通信 |

### 三大核心能力

| 能力 | 说明 |
|------|------|
| **Tools（工具）** | LLM 调用的动作，有副作用（查天气、发邮件、写数据库） |
| **Resources（资源）** | LLM 读取的数据，只读（文件内容、数据库 Schema） |
| **Prompts（提示模板）** | 预制提示词模板（"总结日报"、"生成周报"） |

### 通信格式

- 基于 **JSON-RPC 2.0**
- 工具参数描述使用 **JSON Schema**

### 核心优势

- 一套标准对接所有工具
- 换任何 LLM 都无缝兼容（Claude / GPT / Gemini / 开源模型）
- 本地/远程部署均可
- MCP Server 是被动的服务提供者，不做决策（区别于 Agent）

---

## 三、GPTs（OpenAI 的产品化 Agent）

OpenAI 在 ChatGPT 内部提供的功能，让普通用户无需编程即可创建自己的定制 AI 助手。

### 主要构成

- **Instructions**：自定义指令
- **Knowledge**：上传知识文档
- **Actions**：配置外部 API（本质上也是工具调用）

### 局限性

- ❌ 只能用 OpenAI 模型
- ❌ 只能在 ChatGPT 界面内使用
- ❌ 定制深度有限，无工作流编排
- ❌ 数据在 OpenAI 服务器上

### 与 Dify 的区别

| 维度 | GPTs | Dify |
|------|------|------|
| 产品形态 | ChatGPT 内部功能 | 独立 AI 应用开发平台 |
| 用户 | 普通用户 | 开发者/技术用户 |
| 定制程度 | 受限于 OpenAI 沙盒 | 开放：自选模型、工作流编排 |
| 对外暴露 | 仅 ChatGPT 内部 | 可发布为独立 API / Web App |
| 底层模型 | 仅 OpenAI | 多种模型（含 Claude / 本地模型） |

---

## 四、完整对比：MCP vs GPTs

| 维度 | MCP | GPTs |
|------|-----|------|
| **本质** | 通信协议 | 应用产品 |
| **提出者** | Anthropic | OpenAI |
| **开放性** | 开放标准，任何人可实现 | 闭源，仅限 OpenAI 生态 |
| **支持模型** | 任意模型 | 仅 OpenAI 模型 |
| **用户画像** | 开发者 | 普通用户 ~ 开发者 |
| **可编程性** | 协议层，完全灵活 | 配置化，有限定制 |
| **部署方式** | 本地 / 远程均可 | 仅 OpenAI 云端 |
| **定位** | 基础设施（协议层） | 应用产品（应用层） |
| **类比** | USB-C 标准 | 品牌手机（封闭生态） |

---

## 五、Agent 生态全景

```
用户 → GPTs（产品）→ GPT-4o（模型）→ MCP（标准）→ 工具（API/数据库/文件）
```

| 生态位 | 说明 | 代表 |
|--------|------|------|
| **MCP** | 工具连接标准 | Anthropic 提出，开放协议 |
| **GPTs** | OpenAI 产品化 Agent | ChatGPT 内部定制助手 |
| **Skills / 插件** | 平台特定的行为扩展 | Claude Code Skills、ChatGPT Plugins |
| **Agent 框架** | 构建 Agent 的开发框架 | LangChain、AutoGen、CrewAI |
| **低代码平台** | 可视化构建 AI 工作流 | Dify、Coze、Flowise |
| **托管服务** | Agent 即服务 | Anthropic Agent、OpenAI Agent SDK |

---

## 金句总结

**MCP** 是 Agent 的 **"USB-C 接口"**——定义了工具怎么插、数据怎么流，是基础设施。
**GPTs** 是 OpenAI 做的 **"品牌手机"**——开箱即用但只能在它的生态里转。

二者不矛盾——MCP 是开放标准，理论上 GPTs 也可以基于它构建。
标准越统一，产品越强大。
