# Claude Code 架构总览

## 项目简介

Claude Code 是一个基于 TypeScript/Bun 构建的 AI 编程助手 CLI 工具，核心是将 Anthropic Claude 模型与本地开发环境深度集成。它既支持交互式 REPL 模式，也支持无头（headless）脚本模式，并通过 Bridge/Remote Control 实现远程控制。

---

## 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户入口层 (Entrypoints)                       │
│                                                                     │
│  cli.tsx (快速路径分发)  ──►  main.tsx (完整 CLI 初始化)              │
│       │                                                             │
│       ├── --version / --bare / --bg / bridge / daemon 等快速路径     │
│       └── 正常路径 → main() → launchRepl() / runHeadless()          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  交互式 REPL     │  │  无头/SDK 模式   │  │  Bridge 远程控制  │
│  (screens/REPL) │  │  (QueryEngine)  │  │  (bridge/)      │
│                 │  │                 │  │                 │
│  Ink TUI 渲染   │  │  -p / SDK API   │  │  claude.ai 远程  │
│  React 组件树   │  │  AsyncGenerator │  │  WebSocket 通信  │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        核心查询引擎 (query.ts / QueryEngine.ts)        │
│                                                                     │
│  processUserInput() → query() → Anthropic API 流式调用               │
│  工具调用循环 (Tool Use Loop) → canUseTool() 权限检查                  │
│  消息历史管理 / 会话持久化 / Token 预算控制                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
     ┌─────────────────────────┼─────────────────────────┐
     ▼                         ▼                         ▼
┌──────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  工具系统     │      │  状态管理         │      │  服务层           │
│  (tools/)    │      │  (state/)        │      │  (services/)     │
│              │      │                  │      │                  │
│ BashTool     │      │ AppState         │      │ MCP Client       │
│ FileEditTool │      │ AppStateStore    │      │ Analytics        │
│ AgentTool    │      │ Store (Zustand)  │      │ OAuth/Auth       │
│ WebSearch    │      │                  │      │ LSP              │
│ MCPTool      │      │                  │      │ Compact/Memory   │
│ ...40+ tools │      │                  │      │ PolicyLimits     │
└──────────────┘      └──────────────────┘      └──────────────────┘
```

---

## 核心模块一览

| 模块 | 路径 | 职责 |
|------|------|------|
| 入口 | `entrypoints/cli.tsx` | 快速路径分发，最小化启动开销 |
| 主程序 | `main.tsx` | CLI 初始化、参数解析、会话启动 |
| 查询引擎 | `QueryEngine.ts` / `query.ts` | 与 Claude API 交互的核心循环 |
| 工具抽象 | `Tool.ts` | 所有工具的类型定义与接口规范 |
| 任务抽象 | `Task.ts` | 后台任务类型与状态机 |
| 状态管理 | `state/AppStateStore.ts` | 全局应用状态（Zustand-like） |
| 工具注册 | `tools.ts` | 工具池组装与权限过滤 |
| 渲染引擎 | `ink/` | 自定义 Ink TUI 渲染器 |
| Bridge | `bridge/` | 远程控制协议实现 |
| 命令系统 | `commands/` | 斜杠命令（/help, /config 等） |
| 服务层 | `services/` | MCP、OAuth、Analytics 等 |
| 工具实现 | `tools/` | 40+ 具体工具实现 |

---

## 启动流程

```
cli.tsx::main()
  │
  ├── 快速路径检测（--version, bridge, daemon, bg 等）
  │
  └── 正常路径
        │
        ├── startCapturingEarlyInput()     // 捕获用户早期输入
        ├── import('../main.js')           // 动态加载完整 CLI
        └── main()
              │
              ├── eagerLoadSettings()      // 提前加载配置
              ├── runMigrations()          // 数据迁移
              ├── init()                   // 初始化（auth, telemetry, MCP...）
              ├── loadPolicyLimits()       // 企业策略加载
              ├── getTools()              // 工具池初始化
              │
              ├── [交互模式] launchRepl()
              │     └── renderAndRun(<REPL />)  // Ink TUI
              │
              └── [无头模式] runHeadless()
                    └── QueryEngine.submitMessage()
```

---

## 数据流

```
用户输入
  │
  ▼
processUserInput()          // 解析斜杠命令、附件、@mentions
  │
  ▼
query()                     // 构建 API 请求，流式调用 Claude
  │
  ├── 收到 text block       → 渲染到 UI / 输出到 stdout
  │
  └── 收到 tool_use block
        │
        ├── canUseTool()    // 权限检查（hooks, 规则, 用户确认）
        │
        ├── [允许] tool.call()  // 执行工具
        │     └── 返回 ToolResult → 追加 tool_result 消息
        │
        └── [拒绝] 返回拒绝消息 → 继续循环
```
