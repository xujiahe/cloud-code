# 权限与安全系统

## 概述

Claude Code 有多层权限控制，确保 AI 操作的安全性：工具级权限检查、用户确认流程、沙箱执行、企业策略限制。

---

## 权限模式（`utils/permissions/PermissionMode.ts`）

```typescript
type PermissionMode =
  | 'default'            // 危险操作需用户确认
  | 'auto'               // 自动批准（YOLO 模式，需 GrowthBook 开关）
  | 'plan'               // 只读计划模式，不执行写操作
  | 'bypassPermissions'  // 跳过所有权限检查（需明确启用）
```

---

## 权限检查流程（`utils/permissions/permissions.ts`）

```
canUseTool(tool, input, context, ...)
  │
  ├── 1. tool.validateInput()        → 工具特定输入验证
  │
  ├── 2. alwaysDenyRules 检查        → 全局拒绝规则（立即拒绝）
  │
  ├── 3. alwaysAllowRules 检查       → 全局允许规则（立即允许）
  │
  ├── 4. tool.checkPermissions()     → 工具特定权限逻辑
  │
  ├── 5. PreToolUse hooks            → 用户自定义 hooks
  │
  ├── 6. 自动分类器（auto 模式）      → AI 分类器判断安全性
  │
  └── 7. 用户交互确认（REPL 模式）    → 显示权限对话框
```

---

## 权限规则（`types/permissions.ts`）

```typescript
type ToolPermissionRulesBySource = {
  command?: string[]      // 命令级规则（如 "Bash(git *)"）
  // 按来源分组的规则
}

// 规则格式示例：
// "Bash"           → 允许/拒绝所有 Bash 命令
// "Bash(git *)"    → 允许/拒绝 git 开头的 Bash 命令
// "FileEdit"       → 允许/拒绝所有文件编辑
// "FileEdit(src/*)" → 允许/拒绝 src/ 下的文件编辑
// "mcp__server"    → 允许/拒绝某 MCP 服务器的所有工具
```

---

## 沙箱（`utils/sandbox/`）

### macOS 沙箱

```typescript
// SandboxManager 管理 macOS sandbox-exec
SandboxManager.isSandboxingEnabled()
SandboxManager.areUnsandboxedCommandsAllowed()
SandboxManager.isAutoAllowBashIfSandboxedEnabled()

// BashTool 在沙箱中执行命令
// 限制文件系统访问、网络访问等
```

### 沙箱配置

```typescript
// 沙箱配置文件（sandbox profile）
// 定义允许的系统调用、文件路径、网络访问
// 基于 macOS sandbox-exec 机制
```

---

## 自动分类器（`utils/permissions/autoModeState.ts`）

在 auto 模式下，AI 分类器判断操作安全性：

```typescript
// TRANSCRIPT_CLASSIFIER 功能开关控制
// 分析工具调用的上下文和意图
// 对高风险操作（删除、网络请求等）额外审查
// 超过拒绝阈值时回退到用户确认
```

---

## 拒绝追踪（`utils/permissions/denialTracking.ts`）

```typescript
type DenialTrackingState = {
  denialCount: number
  lastDenialTime: number
}

// 追踪权限拒绝次数
// 超过阈值时从自动模式回退到提示模式
// 防止 AI 反复尝试被拒绝的操作
```

---

## 文件系统权限（`utils/permissions/filesystem.ts`）

```typescript
// 工作目录限制
// 防止访问工作目录外的文件
isScratchpadEnabled()   // 是否启用临时目录
getScratchpadDir()      // 获取临时目录路径

// 额外工作目录（--add-dir 参数）
type AdditionalWorkingDirectory = {
  path: string
  readOnly?: boolean
}
```

---

## 权限设置（`utils/permissions/permissionSetup.ts`）

```typescript
initializeToolPermissionContext(options)
  // 从 CLI 参数、设置文件、环境变量初始化权限上下文

initialPermissionModeFromCLI(args)
  // 从 CLI 参数解析初始权限模式

parseToolListFromCLI(toolsArg)
  // 解析 --tools 参数

stripDangerousPermissionsForAutoMode(context)
  // auto 模式下移除危险权限规则

checkAndDisableBypassPermissions()
  // 检查并禁用 bypass 权限模式（安全检查）
```

---

## Hooks 系统（`utils/hooks/`）

用户可定义 hooks 在工具调用前后执行自定义逻辑：

```typescript
// utils/hooks/hookEvents.ts
type HookEvent =
  | 'PreToolUse'    // 工具调用前
  | 'PostToolUse'   // 工具调用后
  | 'Stop'          // 对话停止时
  | 'Notification'  // 通知时

// hooks 配置（~/.claude/hooks.json）
type HookConfig = {
  event: HookEvent
  tool?: string          // 匹配特定工具
  command: string        // 执行的 shell 命令
  // 或
  type: 'ask'            // 询问用户
  prompt: string
}
```

### Hook 执行流程

```
PreToolUse hook 触发
  │
  ├── 执行 hook 命令（shell 或 ask）
  ├── 解析输出（JSON）
  │   ├── { "allow": true }  → 允许工具调用
  │   ├── { "allow": false } → 拒绝工具调用
  │   └── { "updatedInput": {...} } → 修改输入后允许
  └── 继续权限检查流程
```

---

## 信任对话框（`components/TrustDialog/`）

首次运行时显示，用户需要明确信任当前目录：

```typescript
// 防止在不受信任的目录中执行 git hooks 等
// 信任状态存储在 globalConfig.hasTrustDialogAccepted
checkHasTrustDialogAccepted()
```

---

## 安全存储（`utils/secureStorage/`）

```typescript
// macOS Keychain 存储 OAuth tokens
// 启动时预取（startKeychainPrefetch）
// 避免同步 spawn 阻塞启动
ensureKeychainPrefetchCompleted()
```

---

## 企业安全

### mTLS（`utils/mtls.ts`）

```typescript
// 支持客户端证书认证
// CLAUDE_CODE_CLIENT_CERT 环境变量
```

### CA 证书（`utils/caCerts.ts`）

```typescript
// 支持自定义 CA 证书
// NODE_EXTRA_CA_CERTS 环境变量
// --use-system-ca Node.js 选项
```

### 上游代理（`upstreamproxy/`）

```typescript
// 支持 HTTP/HTTPS 代理
// 企业网络环境下的代理配置
```
