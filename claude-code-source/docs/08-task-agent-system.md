# 任务与 Agent 系统（Tasks & Agents）

## 概述

Claude Code 支持多种并发执行模式：后台 Shell 任务、子 Agent（in-process 和 remote）、Agent Swarm（多 Agent 协作）。

---

## 任务类型（`src/Task.ts`）

```typescript
type TaskType =
  | 'local_bash'           // 本地 Shell 命令（后台执行）
  | 'local_agent'          // 本地子 Agent（同进程）
  | 'remote_agent'         // 远程 Agent（CCR/云端）
  | 'in_process_teammate'  // 同进程队友（Swarm 成员）
  | 'local_workflow'       // 本地工作流
  | 'monitor_mcp'          // MCP 监控任务
  | 'dream'                // Dream 任务（实验性）

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

### 任务 ID 格式

```
b<8位随机字符>  → local_bash
a<8位随机字符>  → local_agent
r<8位随机字符>  → remote_agent
t<8位随机字符>  → in_process_teammate
w<8位随机字符>  → local_workflow
m<8位随机字符>  → monitor_mcp
d<8位随机字符>  → dream
```

---

## 任务实现（`src/tasks/`）

### LocalShellTask（`tasks/LocalShellTask/`）

后台 Shell 命令执行：

```typescript
// 通过 BashTool 的后台模式触发
// 输出写入 outputFile（磁盘文件）
// 通过 TaskOutputTool 读取输出
type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  kind?: 'bash' | 'monitor'
}
```

### LocalAgentTask（`tasks/LocalAgentTask/`）

同进程子 Agent：

```typescript
// AgentTool 触发
// 在同一 Node.js 进程中运行，共享内存
// 有独立的 AbortController 和消息历史
// 通过 setAppState 更新父进程状态
```

### RemoteAgentTask（`tasks/RemoteAgentTask/`）

远程 Agent（CCR 云端执行）：

```typescript
// 通过 Teleport 功能触发
// 在 Anthropic 云端容器中执行
// 通过 WebSocket 接收进度更新
// 支持 ultraplan 模式
```

### InProcessTeammateTask（`tasks/InProcessTeammateTask/`）

同进程队友（Agent Swarm 成员）：

```typescript
// 在同一进程中运行的独立 Agent
// 有独立的消息历史和工具上下文
// 通过 mailbox 与其他 Agent 通信
// 支持查看队友的消息历史（viewingAgentTaskId）
```

### DreamTask（`tasks/DreamTask/`）

实验性异步任务（后台推测执行）。

---

## AgentTool（`tools/AgentTool/`）

AgentTool 是启动子 Agent 的核心工具。

### 关键文件

| 文件 | 职责 |
|------|------|
| `AgentTool.ts` | 工具主体，决定启动本地还是远程 Agent |
| `loadAgentsDir.ts` | 加载 Agent 定义（`~/.claude/agents/`） |
| `agentColorManager.ts` | Agent 颜色分配（UI 区分） |
| `runAgent.ts` | 本地 Agent 执行逻辑 |
| `forkSubagent.ts` | 子 Agent 上下文 fork |
| `createSubagentContext.ts` | 创建子 Agent 的 ToolUseContext |

### Agent 定义

```typescript
type AgentDefinition = {
  name: string
  description: string
  model?: string           // 可指定不同模型
  tools?: string[]         // 工具白名单
  systemPrompt?: string    // 自定义系统提示
  // ...
}
```

### 内置 Agent 类型

- `default`：标准 Claude Code Agent
- `coordinator`：协调者模式（管理其他 Agent）
- 自定义：用户在 `~/.claude/agents/` 定义

---

## Agent Swarm（`utils/swarm/`）

多 Agent 协作系统，支持并行执行复杂任务。

### 架构

```
Leader Agent (主进程)
    │
    ├── TeamCreateTool → 创建团队
    │     └── 在 tmux pane 中启动 Worker Agent
    │
    ├── SendMessageTool → 向 Worker 发送消息
    │
    └── Worker Agent 1, 2, 3... (独立进程)
          └── 通过 mailbox 接收/发送消息
```

### 通信机制

```typescript
// utils/mailbox.ts
// 基于文件系统的消息队列
// 每个 Agent 有独立的 mailbox 目录
// Leader 通过 SendMessageTool 写入消息
// Worker 通过 useInboxPoller 轮询读取
```

### Swarm 相关文件

| 文件 | 职责 |
|------|------|
| `utils/swarm/` | Swarm 核心逻辑 |
| `utils/teammate.ts` | 队友工具函数 |
| `utils/teammateContext.ts` | 队友上下文 |
| `utils/teammateMailbox.ts` | 队友消息队列 |
| `utils/teamDiscovery.ts` | 团队发现 |
| `hooks/useSwarmInitialization.ts` | Swarm 初始化 hook |
| `hooks/useSwarmPermissionPoller.ts` | Swarm 权限轮询 |

---

## Coordinator 模式（`coordinator/`）

协调者模式，一个 Agent 协调多个 Worker Agent：

```typescript
// coordinator/coordinatorMode.ts
isCoordinatorMode()  // 是否处于协调者模式
getCoordinatorUserContext()  // 获取协调者上下文

// 协调者有特殊工具集：
// - AgentTool（启动 Worker）
// - TaskStopTool（停止任务）
// - SendMessageTool（发消息）
// 不包含文件操作工具（由 Worker 执行）
```

---

## Teleport（远程执行）

将任务"传送"到 Anthropic 云端执行：

```typescript
// utils/teleport.ts
teleportToRemoteWithErrorHandling(options)
  │
  ├── 验证 git 状态
  ├── 创建远程会话（POST /sessions）
  ├── 推送代码到远程
  └── 返回远程会话 URL

// 用于 ultraplan 功能：
// 用户发送复杂任务 → 在云端并行执行 → 返回结果
```

---

## 任务输出管理

```typescript
// utils/task/diskOutput.ts
getTaskOutputPath(taskId)  // 任务输出文件路径
// 格式：~/.claude/tasks/<taskId>.txt

// tools/TaskOutputTool/
// 读取任务输出文件，支持流式读取（offset）
```

---

## 后台任务通知

```typescript
// hooks/useTaskListWatcher.ts
// 监听任务状态变化，发送 OS 通知

// services/AgentSummary/
// 任务完成时生成摘要通知
```
