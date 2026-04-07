# Claude Code 源码分析文档索引

> 基于 `claude-code-source/src/` 源码的完整架构分析

---

## 文档列表

| 文档 | 内容 |
|------|------|
| [01-architecture-overview.md](./01-architecture-overview.md) | 整体架构图、模块一览、启动流程、数据流 |
| [02-core-engine.md](./02-core-engine.md) | QueryEngine、query.ts、工具调用循环、上下文压缩 |
| [03-tool-system.md](./03-tool-system.md) | Tool 接口、40+ 工具分类、工具池组装、权限系统 |
| [04-state-management.md](./04-state-management.md) | AppState 结构、Store 模式、状态更新、副作用 |
| [05-bridge-remote-control.md](./05-bridge-remote-control.md) | Bridge 架构、远程控制协议、会话执行、安全机制 |
| [06-services-layer.md](./06-services-layer.md) | MCP、OAuth、Analytics、LSP、策略限制等服务 |
| [07-ink-tui-renderer.md](./07-ink-tui-renderer.md) | 自定义 Ink 渲染器、React reconciler、终端 I/O |
| [08-task-agent-system.md](./08-task-agent-system.md) | 任务类型、AgentTool、Swarm、Coordinator、Teleport |
| [09-commands-plugins-skills.md](./09-commands-plugins-skills.md) | 斜杠命令、插件系统、Skill 系统、键绑定 |
| [10-settings-config.md](./10-settings-config.md) | 配置层级、MDM 策略、环境变量、数据迁移 |
| [11-ui-components.md](./11-ui-components.md) | 组件树、工具 UI、对话框、主题系统 |
| [12-permissions-security.md](./12-permissions-security.md) | 权限模式、检查流程、沙箱、Hooks、企业安全 |
| [13-startup-performance.md](./13-startup-performance.md) | 快速路径、并行预取、DCE、提示缓存 |
| [14-session-memory.md](./14-session-memory.md) | 会话存储、CLAUDE.md 记忆、文件历史、Compact |
| [15-streaming-parsing-deep-dive.md](./15-streaming-parsing-deep-dive.md) | SSE 流式分片处理、工具参数 JSON 拼接、数据流向 |
| [16-plugin-system-deep-dive.md](./16-plugin-system-deep-dive.md) | 插件清单、加载流程、MCP 服务器、安全机制 |
| [17-skill-command-interaction.md](./17-skill-command-interaction.md) | Skill/命令/代码交互、fork 模式、动态发现 |
| [18-memory-context-deep-dive.md](./18-memory-context-deep-dive.md) | CLAUDE.md 层级、Auto Memory、记忆召回、提取整合 |
| [19-context-window-management.md](./19-context-window-management.md) | Token 预算、自动压缩、微压缩、上下文折叠 |

---

## 快速导航

### 想了解"Claude 如何处理用户输入"
→ [02-core-engine.md](./02-core-engine.md) - QueryEngine.submitMessage() 流程

### 想了解"工具是如何定义和执行的"
→ [03-tool-system.md](./03-tool-system.md) - Tool 接口与工具分类

### 想了解"权限检查是怎么工作的"
→ [12-permissions-security.md](./12-permissions-security.md) - 权限检查流程

### 想了解"如何与 claude.ai 远程连接"
→ [05-bridge-remote-control.md](./05-bridge-remote-control.md) - Bridge 架构

### 想了解"MCP 工具是如何集成的"
→ [06-services-layer.md](./06-services-layer.md) - MCP 服务

### 想了解"多 Agent 协作是怎么实现的"
→ [08-task-agent-system.md](./08-task-agent-system.md) - Agent Swarm

### 想了解"启动为什么这么快"
→ [13-startup-performance.md](./13-startup-performance.md) - 性能优化

### 想了解"CLAUDE.md 记忆文件如何工作"
→ [14-session-memory.md](./14-session-memory.md) - 记忆系统

---

## 关键文件速查

| 文件 | 作用 |
|------|------|
| `src/entrypoints/cli.tsx` | 程序入口，快速路径分发 |
| `src/main.tsx` | 完整 CLI 初始化（4684 行） |
| `src/QueryEngine.ts` | SDK/无头模式核心引擎 |
| `src/query.ts` | Anthropic API 调用循环 |
| `src/Tool.ts` | 工具接口类型定义 |
| `src/tools.ts` | 工具池注册与组装 |
| `src/Task.ts` | 任务类型与状态机 |
| `src/state/AppStateStore.ts` | 全局状态定义 |
| `src/screens/REPL.tsx` | 交互式 REPL 主屏幕 |
| `src/bridge/bridgeMain.ts` | Bridge 远程控制主入口 |
| `src/services/mcp/client.ts` | MCP 客户端 |
| `src/utils/permissions/permissions.ts` | 权限检查核心逻辑 |
| `src/ink/ink.tsx` | TUI 渲染器入口 |

---

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript | 主要开发语言 |
| Bun | 运行时 + 构建工具 |
| React | UI 组件框架 |
| Ink（自定义） | 终端 UI 渲染 |
| Yoga Layout | Flexbox 布局引擎 |
| Zod | 运行时类型验证 |
| Commander.js | CLI 参数解析 |
| GrowthBook | 功能开关 |
| Anthropic SDK | Claude API 客户端 |
| MCP SDK | Model Context Protocol |
