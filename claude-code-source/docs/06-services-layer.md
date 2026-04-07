# 服务层（Services）

## 概述

`src/services/` 包含各类独立服务，负责 MCP 集成、认证、分析、上下文管理等横切关注点。

---

## MCP 服务（`services/mcp/`）

Model Context Protocol 集成，让 Claude 能调用外部工具服务器。

### 核心文件

| 文件 | 职责 |
|------|------|
| `client.ts` | MCP 客户端管理，工具/命令/资源获取 |
| `config.ts` | MCP 配置解析（`~/.claude/mcp.json`） |
| `types.ts` | MCP 类型定义 |
| `officialRegistry.ts` | 官方 MCP 服务器注册表 |
| `claudeai.ts` | claude.ai 托管 MCP 配置获取 |
| `elicitationHandler.ts` | MCP 工具 URL 认证请求处理 |
| `channelPermissions.ts` | 渠道权限（Telegram/iMessage 等） |

### MCP 工具动态生成

```typescript
// 每个 MCP 服务器的工具被动态包装为 Tool 对象
// 工具名格式：mcp__<serverName>__<toolName>
// 或无前缀模式（CLAUDE_AGENT_SDK_MCP_NO_PREFIX）

getMcpToolsCommandsAndResources(mcpClients)
  → { tools: Tool[], commands: Command[], resources: ServerResource[] }
```

### MCP 配置来源

1. 用户级：`~/.claude/mcp.json`
2. 项目级：`.claude/mcp.json`
3. 企业级：MDM/策略配置
4. claude.ai 托管：`fetchClaudeAIMcpConfigsIfEligible()`
5. 内联（SDK）：`--mcp-config` 参数

---

## 认证服务（`services/oauth/`）

OAuth 2.0 流程，支持 claude.ai 账号登录。

```typescript
// utils/auth.ts
getClaudeAIOAuthTokens()  // 获取当前 OAuth tokens
refreshOAuthTokens()      // 刷新 access token
```

### 认证方式

| 方式 | 说明 |
|------|------|
| Claude.ai OAuth | 主要认证方式，支持 Pro/Max 订阅 |
| API Key | `ANTHROPIC_API_KEY` 环境变量 |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` |
| GCP Vertex | `CLAUDE_CODE_USE_VERTEX=1` |

---

## 分析服务（`services/analytics/`）

基于 GrowthBook 的功能开关和事件追踪。

```typescript
// services/analytics/growthbook.ts
initializeGrowthBook()           // 初始化（需要 auth）
getFeatureValue_CACHED_MAY_BE_STALE(key, default)  // 功能开关

// services/analytics/index.ts
logEvent('event_name', { ...metadata })  // 事件追踪
```

### 功能开关（Feature Flags）

- 运行时：GrowthBook（需要网络）
- 构建时：`feature('FLAG_NAME')`（Bun bundle 宏，DCE）

---

## 上下文压缩（`services/compact/`）

当对话历史接近 context window 时自动压缩。

```typescript
// 压缩策略
type CompactStrategy =
  | 'auto'      // 自动检测（默认）
  | 'manual'    // 用户手动触发 /compact
  | 'snip'      // 历史片段压缩（HISTORY_SNIP 功能）
```

### 压缩流程

```
检测 token 接近上限（tokenBudget.ts）
  │
  ├── 调用 Claude 生成摘要
  ├── 替换历史为摘要 + compact_boundary 标记
  └── 继续对话
```

---

## 记忆服务（`services/extractMemories/`、`memdir/`）

自动提取和管理对话记忆。

```typescript
// memdir/memdir.ts
loadMemoryPrompt()  // 加载 CLAUDE.md 记忆文件

// memdir/findRelevantMemories.ts
findRelevantMemories(query, memories)  // 语义搜索相关记忆

// memdir/memoryScan.ts
scanForMemories(dir)  // 扫描目录中的记忆文件
```

### 记忆文件层级

```
~/.claude/CLAUDE.md          # 全局记忆
<project>/.claude/CLAUDE.md  # 项目记忆
<subdir>/CLAUDE.md           # 子目录记忆（嵌套记忆）
```

---

## LSP 服务（`services/lsp/`）

Language Server Protocol 集成，提供代码智能。

```typescript
// services/lsp/manager.ts
initializeLspServerManager()  // 初始化 LSP 服务器管理器
// 支持：diagnostics, hover, completion, references 等
```

---

## 策略限制（`services/policyLimits/`）

企业策略控制，限制功能使用。

```typescript
loadPolicyLimits()
isPolicyAllowed('allow_remote_control')  // 检查策略
isPolicyAllowed('allow_mcp')
// 策略来源：MDM（macOS）/ 注册表（Windows）/ 环境变量
```

---

## 远程托管设置（`services/remoteManagedSettings/`）

从 claude.ai 服务端拉取托管配置。

```typescript
loadRemoteManagedSettings()   // 初始化加载
refreshRemoteManagedSettings() // 定期刷新
```

---

## 提示建议（`services/PromptSuggestion/`）

基于上下文的提示词建议。

```typescript
shouldEnablePromptSuggestion()  // 是否启用
// 在用户输入时显示 AI 生成的提示建议
```

---

## 速率限制（`services/claudeAiLimits.ts`）

```typescript
checkQuotaStatus()  // 检查 claude.ai 配额状态
// 处理 429 速率限制，显示等待时间
```

---

## 工具使用摘要（`services/toolUseSummary/`）

生成工具使用的简洁摘要，用于 Away 模式通知。

---

## Agent 摘要（`services/AgentSummary/`）

为后台 Agent 任务生成摘要，在任务完成时通知用户。

---

## 设置同步（`services/settingsSync/`）

跨设备设置同步（企业功能）。

---

## 团队记忆同步（`services/teamMemorySync/`）

团队共享记忆文件同步。
