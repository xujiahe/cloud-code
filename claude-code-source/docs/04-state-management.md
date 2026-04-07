# 状态管理（State Management）

## 概述

Claude Code 使用类 Zustand 的响应式状态管理，核心是 `AppState` 这个巨型状态对象，通过 `Store<AppState>` 实现订阅/更新。

---

## AppState（`src/state/AppStateStore.ts`）

`AppState` 是整个应用的单一状态源，包含以下主要分区：

### 基础配置

```typescript
{
  settings: SettingsJson          // 用户设置（来自 settings.json）
  verbose: boolean                // 详细输出模式
  mainLoopModel: ModelSetting     // 当前使用的模型
  mainLoopModelForSession: ModelSetting
  agent: string | undefined       // --agent 参数指定的 agent 类型
  kairosEnabled: boolean          // Assistant 模式是否启用
}
```

### 权限上下文

```typescript
{
  toolPermissionContext: ToolPermissionContext = {
    mode: PermissionMode           // default | auto | plan | bypassPermissions
    additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
    alwaysAllowRules: ToolPermissionRulesBySource
    alwaysDenyRules: ToolPermissionRulesBySource
    alwaysAskRules: ToolPermissionRulesBySource
    isBypassPermissionsModeAvailable: boolean
  }
}
```

### 任务系统

```typescript
{
  tasks: { [taskId: string]: TaskState }  // 所有后台任务
  agentNameRegistry: Map<string, AgentId> // Agent 名称 → ID 映射
  foregroundedTaskId?: string             // 当前前台任务
  viewingAgentTaskId?: string             // 正在查看的 Agent 任务
}
```

### MCP 状态

```typescript
{
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]                  // MCP 动态工具
    commands: Command[]            // MCP 命令
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number     // 触发 MCP 重连
  }
}
```

### Bridge/远程控制状态

```typescript
{
  replBridgeEnabled: boolean
  replBridgeConnected: boolean      // 环境已注册
  replBridgeSessionActive: boolean  // 用户已连接
  replBridgeReconnecting: boolean
  replBridgeConnectUrl: string | undefined
  replBridgeSessionUrl: string | undefined
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  replBridgeError: string | undefined
}
```

### UI 状态

```typescript
{
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  footerSelection: FooterItem | null  // 底部导航焦点
  spinnerTip?: string
  activeOverlays: ReadonlySet<string> // 活跃的对话框
  notifications: { current: Notification | null; queue: Notification[] }
}
```

### 推测执行（Speculation）

```typescript
{
  speculation: SpeculationState = {
    status: 'idle' | 'active'
    // active 时：
    id: string
    abort: () => void
    messagesRef: { current: Message[] }
    writtenPathsRef: { current: Set<string> }
    boundary: CompletionBoundary | null
    // ...
  }
  speculationSessionTimeSavedMs: number
}
```

---

## Store（`src/state/store.ts`）

```typescript
type Store<T> = {
  getState(): T
  setState(f: (prev: T) => T): void
  subscribe(listener: (state: T) => void): () => void
}
```

- 基于发布-订阅模式
- `setState` 接受函数（immutable 更新）
- React 组件通过 `useAppState()` hook 订阅

---

## 状态更新模式

### 在工具中更新状态

```typescript
// ToolUseContext 提供 setAppState
context.setAppState(prev => ({
  ...prev,
  tasks: {
    ...prev.tasks,
    [taskId]: newTaskState
  }
}))
```

### 在 React 组件中订阅

```typescript
// hooks/useSettings.ts
function useSettings() {
  return useAppState(state => state.settings)
}
```

### setAppStateForTasks（基础设施专用）

```typescript
// 用于后台任务注册/清理，即使在子 Agent 中也能到达根 Store
context.setAppStateForTasks?.(f)
```

---

## 文件历史（FileHistory）

```typescript
{
  fileHistory: {
    snapshots: FileHistorySnapshot[]  // 文件快照列表
    trackedFiles: Set<string>         // 被追踪的文件路径
    snapshotSequence: number          // 快照序号
  }
}
```

每次用户发送消息前，对当前工作区文件做快照，支持 `/rewind` 回滚。

---

## 归因状态（Attribution）

```typescript
{
  attribution: AttributionState  // 追踪 Claude 修改的文件，用于 git commit 归因
}
```

---

## onChangeAppState（副作用）

`src/state/onChangeAppState.ts` 监听 AppState 变化，触发副作用：

- Bridge 状态变化 → 更新远程环境元数据
- 任务状态变化 → 发送通知
- 权限模式变化 → 更新 UI 提示
- ultraplan 状态 → 触发远程会话
