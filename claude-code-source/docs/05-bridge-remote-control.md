# Bridge / 远程控制（Remote Control）

## 概述

Bridge 模块让本地 Claude Code 实例作为远程执行环境，通过 claude.ai 网页端或移动端发起任务。核心是"环境注册 → 轮询任务 → 执行会话"的工作流。

---

## 架构

```
claude.ai (Web/Mobile)
        │
        │  WebSocket / SSE
        ▼
  Anthropic 后端 API
        │
        │  HTTP 轮询 (pollForWork)
        ▼
  Bridge 本地进程 (claude remote-control)
        │
        ├── 注册环境 (registerBridgeEnvironment)
        ├── 轮询工作 (pollForWork)
        └── 收到任务 → 启动子进程 (SessionSpawner)
                          │
                          └── claude --session-id <id> ...
```

---

## 核心文件

| 文件 | 职责 |
|------|------|
| `bridge/bridgeMain.ts` | Bridge 主入口，协调整个生命周期 |
| `bridge/bridgeApi.ts` | HTTP API 客户端（注册、轮询、心跳） |
| `bridge/bridgeConfig.ts` | Bridge 配置解析 |
| `bridge/bridgeEnabled.ts` | 功能开关检查（GrowthBook + 版本） |
| `bridge/bridgeMessaging.ts` | 消息传递（权限响应等） |
| `bridge/bridgePermissionCallbacks.ts` | 权限请求回调（远程用户确认） |
| `bridge/bridgeUI.ts` | Bridge 状态 UI（Ink 渲染） |
| `bridge/replBridge.ts` | 常驻 Bridge（REPL 内嵌模式） |
| `bridge/replBridgeHandle.ts` | Bridge 句柄管理 |
| `bridge/replBridgeTransport.ts` | Bridge 传输层 |
| `bridge/sessionRunner.ts` | 会话执行器（子进程管理） |
| `bridge/createSession.ts` | 会话创建逻辑 |
| `bridge/workSecret.ts` | 工作密钥解析（JWT） |
| `bridge/jwtUtils.ts` | JWT 工具函数 |
| `bridge/trustedDevice.ts` | 可信设备管理 |
| `bridge/pollConfig.ts` | 轮询配置（间隔、退避） |
| `bridge/flushGate.ts` | 输出刷新门控 |
| `bridge/capacityWake.ts` | 容量唤醒（空闲时降低轮询频率） |

---

## 工作流程

### 1. 环境注册

```typescript
// bridgeMain.ts
const { environment_id, environment_secret } = await api.registerBridgeEnvironment({
  dir: config.dir,
  machineName: config.machineName,
  branch: config.branch,
  gitRepoUrl: config.gitRepoUrl,
  maxSessions: config.maxSessions,
  spawnMode: config.spawnMode,  // 'single-session' | 'worktree' | 'same-dir'
  workerType: 'claude_code',
  bridgeId: config.bridgeId,
  environmentId: config.environmentId,
  // ...
})
```

### 2. 轮询工作

```typescript
// 持续轮询，直到收到任务
while (true) {
  const work = await api.pollForWork(environmentId, environmentSecret, signal)
  if (work) {
    await handleWork(work)
  }
  // 指数退避 + 容量唤醒
}
```

### 3. 任务处理

```typescript
// work.data.type === 'session' → 启动新会话
const workSecret = parseWorkSecret(work.secret)
// workSecret 包含：
// - session_ingress_token: 会话认证 token
// - api_base_url: API 基础 URL
// - sources: 代码源（git repo 等）
// - auth: 认证信息
// - claude_code_args: 额外 CLI 参数
// - mcp_config: MCP 配置
// - environment_variables: 环境变量

const session = spawner.spawn({
  sessionId: work.id,
  sdkUrl: workSecret.api_base_url,
  accessToken: workSecret.session_ingress_token,
}, dir)
```

### 4. 会话执行

```typescript
// sessionRunner.ts
// 子进程执行：claude --session-id <id> --remote ...
// 子进程通过 SSE/WebSocket 与 claude.ai 通信
// 输出通过 stdout 流式传输
```

---

## Spawn 模式

| 模式 | 说明 |
|------|------|
| `single-session` | 单会话，Bridge 在会话结束后退出 |
| `worktree` | 每个会话创建独立 git worktree，隔离执行 |
| `same-dir` | 所有会话共享同一目录（可能冲突） |

---

## 常驻 Bridge（REPL 内嵌）

`replBridge.ts` 实现了在 REPL 交互模式下的常驻 Bridge：

```
用户在 REPL 中执行 /remote-control
  │
  ├── 注册环境（后台）
  ├── 在 AppState 中更新 replBridgeConnected = true
  ├── 显示连接 URL（replBridgeConnectUrl）
  └── 持续轮询，接受来自 claude.ai 的任务
```

---

## 权限处理

远程会话中，权限请求通过 Bridge 传递给远程用户：

```typescript
// bridgePermissionCallbacks.ts
type BridgePermissionCallbacks = {
  requestPermission(request: PermissionRequest): Promise<PermissionResponse>
  // 通过 WebSocket 发送权限请求到 claude.ai
  // 等待用户在 claude.ai 上点击允许/拒绝
}
```

---

## 安全机制

- **JWT 验证**：`jwtUtils.ts` 验证 session_ingress_token
- **可信设备**：`trustedDevice.ts` 管理设备信任状态
- **工作密钥**：`workSecret.ts` 解析 base64url 编码的 JSON 密钥
- **策略限制**：`isPolicyAllowed('allow_remote_control')` 企业策略检查
- **版本检查**：`checkBridgeMinVersion()` 确保客户端版本兼容

---

## 类型定义（`bridge/types.ts`）

```typescript
type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{ type: string; git_info?: {...} }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  use_code_sessions?: boolean  // CCR v2 选择器
}

type SpawnMode = 'single-session' | 'worktree' | 'same-dir'

type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'
```
