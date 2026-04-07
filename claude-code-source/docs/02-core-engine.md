# 核心引擎：QueryEngine & query.ts

## 概述

`QueryEngine` 是 Claude Code 无头/SDK 模式的核心，`query.ts` 是底层 API 调用循环。两者共同实现了与 Claude API 的多轮对话、工具调用、会话持久化。

---

## QueryEngine（`src/QueryEngine.ts`）

### 职责

- 管理单个会话的完整生命周期（消息历史、token 用量、权限拒绝记录）
- 对外暴露 `submitMessage()` 异步生成器，SDK 消费者通过 `for await` 获取事件流
- 处理斜杠命令、附件、@mentions 的预处理
- 会话持久化（`recordTranscript`）

### 核心状态

```typescript
class QueryEngine {
  private mutableMessages: Message[]        // 消息历史（可变）
  private abortController: AbortController  // 取消控制
  private permissionDenials: SDKPermissionDenial[]  // 权限拒绝记录
  private totalUsage: NonNullableUsage      // 累计 token 用量
  private discoveredSkillNames: Set<string> // 本轮发现的 skill
  private loadedNestedMemoryPaths: Set<string> // 已加载的 CLAUDE.md 路径
}
```

### submitMessage() 流程

```
submitMessage(prompt)
  │
  ├── 1. 初始化：setCwd, 包装 canUseTool（追踪拒绝）
  │
  ├── 2. 获取系统提示：fetchSystemPromptParts()
  │     ├── 默认系统提示（工具描述、权限说明等）
  │     ├── 用户上下文（git 信息、环境变量等）
  │     └── 可选：自定义/追加系统提示
  │
  ├── 3. processUserInput()：解析用户输入
  │     ├── 斜杠命令处理（/compact, /clear 等）
  │     ├── 附件处理（图片、文件）
  │     └── 返回 shouldQuery（是否需要调用 API）
  │
  ├── 4. 持久化用户消息到 transcript
  │
  ├── 5. yield buildSystemInitMessage()  // SDK 初始化消息
  │
  ├── 6. [shouldQuery=false] 直接返回本地命令结果
  │
  └── 7. [shouldQuery=true] for await query(...)
        ├── 收到 assistant 消息 → yield 给调用方
        ├── 收到 progress 消息 → 追加到历史
        ├── 收到 result 消息 → 汇总用量，yield 最终结果
        └── 持久化每条消息
```

### SDK 输出消息类型

```typescript
type SDKMessage =
  | SDKAssistantMessage      // Claude 的文本/工具调用响应
  | SDKUserMessage           // 工具结果（用户侧）
  | SDKSystemMessage         // 系统初始化、compact 边界
  | SDKResultMessage         // 最终结果（含 cost, usage, stop_reason）
  | SDKPermissionDenialMessage
```

---

## query.ts（底层 API 循环）

### 职责

- 构建发送给 Anthropic API 的请求（消息、工具列表、系统提示）
- 处理流式响应（SSE）
- 执行工具调用循环（多轮 agentic loop）
- 处理 compact（上下文压缩）、token 预算、速率限制

### 工具调用循环

```
query()
  │
  ├── 构建 API 请求（messages + tools + system）
  │
  ├── 调用 claude.ts::streamQuery()（流式 SSE）
  │     ├── message_start → 初始化 usage
  │     ├── content_block_start/delta → 累积文本/工具参数
  │     ├── message_delta → 更新 stop_reason, usage
  │     └── message_stop → 完成一轮
  │
  ├── stop_reason = "tool_use"？
  │     │
  │     ├── 并发执行所有工具调用（concurrencySafe 的并行，其余串行）
  │     │     └── canUseTool() → tool.call() → ToolResult
  │     │
  │     ├── 追加 tool_result 消息
  │     │
  │     └── 继续下一轮（直到 stop_reason = "end_turn" 或达到 maxTurns）
  │
  └── stop_reason = "end_turn" → 返回最终结果
```

### 关键配置

```typescript
type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  maxTurns?: number          // 最大工具调用轮数
  maxBudgetUsd?: number      // 最大费用预算
  thinkingConfig?: ThinkingConfig  // 思考模式配置
  customSystemPrompt?: string
  appendSystemPrompt?: string
  // ...
}
```

---

## 上下文压缩（Compact）

当对话历史接近 context window 上限时，自动触发压缩：

```
检测到 token 接近上限
  │
  ├── 调用 compact service（services/compact/）
  │     └── 用 Claude 生成对话摘要
  │
  ├── 替换历史消息为摘要 + compact_boundary 标记
  │
  └── 继续对话（保留最近 N 条消息）
```

---

## 思考模式（Thinking）

```typescript
type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }  // 根据任务复杂度自动决定
```

`adaptive` 模式下，系统会根据用户输入的复杂度动态决定是否启用 extended thinking。
