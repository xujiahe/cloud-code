# SSE 流事件处理深度解析：逐类型展开

## 概述

`queryModel()` 中的 `for await (const part of stream)` 循环是整个系统的心脏。
每个 `part` 是一个 `BetaRawMessageStreamEvent`，共 6 种类型，每种都有精确的处理逻辑和防护机制。

```
API SSE 流
  │
  ├── message_start          → 初始化消息骨架 + 记录 TTFB
  ├── content_block_start    → 按类型初始化内容块槽位
  ├── content_block_delta    → 追加增量数据（字符串拼接）
  ├── content_block_stop     → 完成块 → JSON 解析 → yield AssistantMessage
  ├── message_delta          → 写回 stop_reason + usage（直接 mutation）
  └── message_stop           → 无操作（流结束信号）
```

---

## 一、`message_start`

```typescript
case 'message_start': {
  partialMessage = part.message   // 保存消息骨架（id, model, role...）
  ttftMs = Date.now() - start     // 记录首 token 时间（TTFB）
  usage = updateUsage(usage, part.message?.usage)
  // ant 内部：捕获 research 字段
}
```

### 关键细节

**`partialMessage` 是后续所有 block 的"容器"**。它在 `message_start` 时创建，此时 `content` 为空、`stop_reason` 为 null、`output_tokens` 为 0。这些字段会在后续事件中被**直接 mutation**（而非替换对象）。

**为什么用 mutation 而非替换？**

```typescript
// message_delta 中的注释解释了原因：
// IMPORTANT: Use direct property mutation, not object replacement.
// The transcript write queue holds a reference to message.message
// and serializes it lazily (100ms flush interval). Object replacement
// ({ ...lastMsg.message, usage }) would disconnect the queued reference;
// direct mutation ensures the transcript captures the final values.

lastMsg.message.usage = usage          // ✓ 直接 mutation
lastMsg.message.stop_reason = stopReason  // ✓ 直接 mutation
// 而不是：
// lastMsg = { ...lastMsg, message: { ...lastMsg.message, usage } }  ✗
```

**TTFB 的意义**：`ttftMs` 记录从请求发出到第一个 token 到达的时间，用于性能分析（`logAPISuccessAndDuration`）。

---

## 二、`content_block_start`

```typescript
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',   // ← 关键：初始化为空字符串，不是 {}
      }
      break
    case 'text':
      contentBlocks[part.index] = {
        ...part.content_block,
        text: '',    // ← SDK 有时在 start 里带 text，但我们忽略它
      }
      break
    case 'thinking':
      contentBlocks[part.index] = {
        ...part.content_block,
        thinking: '',
        signature: '',  // ← 提前初始化，防止 signature_delta 从未到达
      }
      break
    default:
      contentBlocks[part.index] = { ...part.content_block }
      // advisor_tool_result 在这里检测，标记 isAdvisorInProgress = false
  }
```

### 关键细节

**`contentBlocks` 是按 `index` 索引的数组**，不是 Map。API 保证 index 从 0 开始连续递增，每个 block 独占一个槽位。

**`tool_use` 的 `input` 初始化为 `''`（空字符串）而非 `{}`**：
- 后续 `input_json_delta` 会做字符串拼接：`contentBlock.input += delta.partial_json`
- 如果初始化为 `{}`，拼接会变成 `"[object Object]{"file_path":...}`，导致 JSON 解析失败
- 只有在 `content_block_stop` 时才做 `JSON.parse`

**SDK 的 text 重复问题**（注释中明确说明）：
```
// awkwardly, the sdk sometimes returns text as part of a
// content_block_start message, then returns the same text
// again in a content_block_delta message. we ignore it here
// since there doesn't seem to be a way to detect when a
// content_block_delta message duplicates the text.
```
所以 `text` 也初始化为 `''`，忽略 `content_block_start` 里可能携带的 text。

**`thinking` 的 `signature` 提前初始化**：
```typescript
signature: '',  // initialize signature to ensure field exists even if signature_delta never arrives
```
如果流在 `signature_delta` 之前断开，`signature` 字段仍然存在（空字符串），不会导致后续访问 undefined。

---

## 三、`content_block_delta`（核心分片处理）

这是最复杂的事件，包含 6 种 delta 子类型：

### 3.1 `input_json_delta`（工具参数分片）

```typescript
case 'input_json_delta':
  // 防护 1：类型检查
  if (contentBlock.type !== 'tool_use' && contentBlock.type !== 'server_tool_use') {
    logEvent('tengu_streaming_error', { error_type: 'content_block_type_mismatch_input_json' })
    throw new Error('Content block is not a input_json block')
  }
  // 防护 2：input 必须是字符串（确保初始化正确）
  if (typeof contentBlock.input !== 'string') {
    logEvent('tengu_streaming_error', { error_type: 'content_block_input_not_string' })
    throw new Error('Content block input is not a string')
  }
  // 核心：字符串追加
  contentBlock.input += delta.partial_json
```

**为什么两个防护都必要？**

防护 1 防止 API 协议错误（index 对应的 block 类型不是 tool_use）。
防护 2 防止状态机错误（`content_block_start` 没有正确初始化 input 为字符串）。

**字符串拼接的完整生命周期**：

```
content_block_start[index=1] { type: 'tool_use', name: 'FileEdit', input: '' }
  → contentBlocks[1] = { type: 'tool_use', name: 'FileEdit', input: '' }

content_block_delta[index=1] { input_json_delta: '{"file_' }
  → contentBlocks[1].input = '{"file_'

content_block_delta[index=1] { input_json_delta: 'path": "src/' }
  → contentBlocks[1].input = '{"file_path": "src/'

content_block_delta[index=1] { input_json_delta: 'foo.ts",' }
  → contentBlocks[1].input = '{"file_path": "src/foo.ts",'

content_block_delta[index=1] { input_json_delta: '"old_string": "x", "new_string": "y"}' }
  → contentBlocks[1].input = '{"file_path": "src/foo.ts","old_string": "x", "new_string": "y"}'

content_block_stop[index=1]
  → JSON.parse('{"file_path": "src/foo.ts","old_string": "x", "new_string": "y"}')
  → { file_path: 'src/foo.ts', old_string: 'x', new_string: 'y' }
```

**如果 JSON 解析失败怎么办？**（`normalizeContentFromAPI` 中）

```typescript
const parsed = safeParseJSON(contentBlock.input)
if (parsed === null && contentBlock.input.length > 0) {
  // 记录遥测（工具名 + 输入长度，不记录内容本身）
  logEvent('tengu_tool_input_json_parse_fail', {
    toolName: sanitizeToolNameForAnalytics(contentBlock.name),
    inputLen: contentBlock.input.length,
  })
  // ant 内部：记录前 200 字符用于调试
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(`tool input JSON parse fail: ${contentBlock.input.slice(0, 200)}`)
  }
}
// 降级为空对象 {}，而不是抛出异常
normalizedInput = parsed ?? {}
```

降级为 `{}` 意味着工具会收到空参数，触发 `validateInput()` 失败，返回错误给模型，模型重新生成正确参数。**不会崩溃，但会多一轮 API 调用**。

### 3.2 `text_delta`（文本分片）

```typescript
case 'text_delta':
  if (contentBlock.type !== 'text') {
    logEvent('tengu_streaming_error', { error_type: 'content_block_type_mismatch_text' })
    throw new Error('Content block is not a text block')
  }
  contentBlock.text += delta.text
```

文本分片最简单：纯字符串追加，无需解析。每个 `text_delta` 到达时，UI 可以立即渲染新增的文字（实时打字效果）。

**注意**：文本块在 `content_block_stop` 时**不做任何解析**，直接作为字符串使用。

### 3.3 `thinking_delta`（思考内容分片）

```typescript
case 'thinking_delta':
  if (contentBlock.type !== 'thinking') {
    logEvent('tengu_streaming_error', { error_type: 'content_block_type_mismatch_thinking_delta' })
    throw new Error('Content block is not a thinking block')
  }
  contentBlock.thinking += delta.thinking
```

与 `text_delta` 类似，但 thinking 块有额外的 `signature` 字段（见下）。

### 3.4 `signature_delta`（thinking 签名）

```typescript
case 'signature_delta':
  if (contentBlock.type !== 'thinking') {
    throw new Error('Content block is not a thinking block')
  }
  contentBlock.signature = delta.signature  // 注意：赋值，不是追加
```

**签名是整体替换，不是追加**。签名用于验证 thinking 块的完整性，防止被篡改。

**签名的重要性**：当流式回退发生时，不完整的 thinking 块（有 thinking 内容但 signature 为空或不完整）会导致 API 拒绝，错误信息为 "thinking blocks cannot be modified"。这是触发 tombstone 清除机制的主要原因之一。

### 3.5 `connector_text_delta`（连接器文本，CONNECTOR_TEXT 功能）

```typescript
if (feature('CONNECTOR_TEXT') && delta.type === 'connector_text_delta') {
  if (contentBlock.type !== 'connector_text') {
    throw new Error('Content block is not a connector_text block')
  }
  contentBlock.connector_text += delta.connector_text
}
```

这是一个实验性功能（`feature('CONNECTOR_TEXT')` 门控），用于连接器工具的文本输出。

### 3.6 `citations_delta`

```typescript
case 'citations_delta':
  // TODO: handle citations
  break
```

目前是 TODO，直接忽略。

---

## 四、`content_block_stop`（最关键的事件）

```typescript
case 'content_block_stop': {
  const contentBlock = contentBlocks[part.index]

  // 防护 1：block 必须存在
  if (!contentBlock) {
    logEvent('tengu_streaming_error', { error_type: 'content_block_not_found_stop' })
    throw new RangeError('Content block not found')
  }

  // 防护 2：partialMessage 必须存在（message_start 必须先到）
  if (!partialMessage) {
    logEvent('tengu_streaming_error', { error_type: 'partial_message_not_found' })
    throw new Error('Message not found')
  }

  // 核心：构建 AssistantMessage 并 yield
  const m: AssistantMessage = {
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI(
        [contentBlock] as BetaContentBlock[],
        tools,
        options.agentId,
      ),
    },
    requestId: streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  newMessages.push(m)
  yield m   // ← 立即推送给上层消费者
  break
}
```

### `normalizeContentFromAPI` 的完整处理

这是 `content_block_stop` 的核心，对不同类型的 block 做不同处理：

```typescript
export function normalizeContentFromAPI(contentBlocks, tools, agentId) {
  return contentBlocks.map(contentBlock => {
    switch (contentBlock.type) {
      case 'tool_use': {
        // 步骤 1：解析 JSON 字符串
        let normalizedInput: unknown
        if (typeof contentBlock.input === 'string') {
          const parsed = safeParseJSON(contentBlock.input)
          if (parsed === null && contentBlock.input.length > 0) {
            // JSON 解析失败：记录遥测，降级为 {}
            logEvent('tengu_tool_input_json_parse_fail', { ... })
          }
          normalizedInput = parsed ?? {}
        } else {
          // 非流式回退时，input 已经是对象
          normalizedInput = contentBlock.input
        }

        // 步骤 2：工具特定的输入规范化
        if (typeof normalizedInput === 'object' && normalizedInput !== null) {
          const tool = findToolByName(tools, contentBlock.name)
          if (tool) {
            try {
              normalizedInput = normalizeToolInput(tool, normalizedInput, agentId)
              // normalizeToolInput 做什么：
              // - BashTool：去掉 "cd /cwd && " 前缀，规范化路径
              // - FileEditTool：规范化 old_string/new_string（处理不可见字符）
              // - FileWriteTool：去掉行尾空白（非 Markdown 文件）
              // - ExitPlanModeV2Tool：注入 plan 内容和 planFilePath
              // - TaskOutputTool：规范化遗留参数名（agentId → task_id）
            } catch (error) {
              logError(new Error('Error normalizing tool input: ' + error))
              // 规范化失败：保留原始 input，不崩溃
            }
          }
        }

        return { ...contentBlock, input: normalizedInput }
      }

      case 'text':
        // 文本块：直接返回，不做任何处理
        // 注意：即使是空白文本也保留（用于提示缓存稳定性）
        if (contentBlock.text.trim().length === 0) {
          logEvent('tengu_model_whitespace_response', { length: contentBlock.text.length })
        }
        return contentBlock

      case 'server_tool_use':
        // advisor 等服务端工具：如果 input 是字符串，解析为对象
        if (typeof contentBlock.input === 'string') {
          return {
            ...contentBlock,
            input: (safeParseJSON(contentBlock.input) ?? {}) as { [key: string]: unknown },
          }
        }
        return contentBlock

      default:
        // beta 特定块（code_execution_tool_result, mcp_tool_use 等）：直接透传
        return contentBlock
    }
  })
}
```

### 为什么每个 block 都立即 yield？

```typescript
newMessages.push(m)
yield m   // 每个 content_block_stop 都 yield 一次
```

**一个 API 响应可能包含多个 block**（例如：text + tool_use），每个 block 完成时立即 yield，让 UI 可以：
1. 立即渲染文本内容（不等工具调用完成）
2. 立即显示工具调用的"正在执行"状态

**同一个 AssistantMessage 会被 yield 多次**（每次包含更多 block）：
```
yield AssistantMessage { content: [{ type: 'text', text: '我来帮你...' }] }
yield AssistantMessage { content: [{ type: 'text', ... }, { type: 'tool_use', name: 'FileEdit', input: {...} }] }
```
上层消费者（query.ts）用最后一次 yield 的版本作为最终消息。

---

## 五、`message_delta`

```typescript
case 'message_delta': {
  usage = updateUsage(usage, part.usage)
  stopReason = part.delta.stop_reason

  // 直接 mutation 最后一条消息（不替换对象）
  const lastMsg = newMessages.at(-1)
  if (lastMsg) {
    lastMsg.message.usage = usage
    lastMsg.message.stop_reason = stopReason
  }

  // 计算费用
  const costUSDForPart = calculateUSDCost(resolvedModel, usage)
  costUSD += addToTotalSessionCost(costUSDForPart, usage, options.model)

  // 特殊 stop_reason 处理
  if (stopReason === 'max_tokens') {
    logEvent('tengu_max_tokens_reached', { max_tokens: maxOutputTokens })
    yield createAssistantAPIErrorMessage({
      content: `API Error: Claude's response exceeded the ${maxOutputTokens} output token maximum...`,
      apiError: 'max_output_tokens',
      error: 'max_output_tokens',
    })
  }

  if (stopReason === 'model_context_window_exceeded') {
    logEvent('tengu_context_window_exceeded', { ... })
    yield createAssistantAPIErrorMessage({
      content: `API Error: The model has reached its context window limit.`,
      apiError: 'max_output_tokens',  // 复用同一个恢复路径
      error: 'max_output_tokens',
    })
  }
}
```

### 关键细节

**`message_delta` 在 `content_block_stop` 之后到达**，这意味着：
- 当 `content_block_stop` yield 消息时，`stop_reason` 还是 null，`output_tokens` 还是 0
- `message_delta` 到达后，通过直接 mutation 更新已经 yield 出去的消息对象
- 这是可行的，因为 JavaScript 对象是引用传递，上层持有的是同一个对象引用

**`max_tokens` 和 `model_context_window_exceeded` 都走同一个恢复路径**：
```typescript
apiError: 'max_output_tokens'
```
query.ts 检测到这个 apiError，触发 `max_output_tokens` 恢复逻辑（增加 max_tokens 重试，最多 3 次）。

**`research` 字段的回写**（ant 内部）：
```typescript
if (process.env.USER_TYPE === 'ant' && 'research' in part) {
  research = part.research
  // 回写到所有已 yield 的消息
  for (const msg of newMessages) {
    msg.research = research
  }
}
```
`research` 字段在 `message_delta` 时才完整，需要回写到之前已经 yield 的消息。

---

## 六、`message_stop`

```typescript
case 'message_stop':
  break  // 无操作
```

`message_stop` 只是流结束的信号，不携带任何数据。真正的结束处理在 `for await` 循环退出后进行。

---

## 七、流结束后的防护检查

```typescript
// 流循环退出后
clearStreamIdleTimers()

// 防护 1：watchdog 超时触发的退出
if (streamIdleAborted) {
  throw new Error('Stream idle timeout - no chunks received')
  // → 触发非流式回退
}

// 防护 2：流完成但没有任何消息
if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
  // 两种情况：
  // 1. !partialMessage：代理返回 200 但不是 SSE 格式（没有 message_start）
  // 2. newMessages.length === 0 && !stopReason：有 message_start 但没有 content_block_stop
  //    注意：!stopReason 排除了结构化输出的合法空响应（第二轮 end_turn 无 content）
  throw new Error('Stream ended without receiving any events')
  // → 触发非流式回退
}
```

---

## 八、非流式回退路径

当流式请求失败时，切换到非流式请求：

```typescript
// 流式失败 → catch(streamingError)
didFallBackToNonStreaming = true
options.onStreamingFallback?.()  // 通知 query.ts 清除不完整消息（tombstone）

const result = yield* executeNonStreamingRequest(...)
// 非流式请求一次性返回完整 BetaMessage

const m: AssistantMessage = {
  message: {
    ...result,
    content: normalizeContentFromAPI(result.content, tools, options.agentId),
    // 非流式时 result.content 已经是完整的对象数组
    // normalizeContentFromAPI 仍然需要运行（工具输入规范化）
  },
  ...
}
newMessages.push(m)
fallbackMessage = m
yield m
```

**非流式时 `normalizeContentFromAPI` 的差异**：
```typescript
case 'tool_use': {
  if (typeof contentBlock.input === 'string') {
    // 流式路径：input 是拼接后的 JSON 字符串，需要 JSON.parse
    normalizedInput = safeParseJSON(contentBlock.input) ?? {}
  } else {
    // 非流式路径：input 已经是对象，直接使用
    normalizedInput = contentBlock.input
  }
}
```

---

## 九、`ensureToolResultPairing`：最后的防线

在 `normalizeMessagesForAPI` 之后，`ensureToolResultPairing` 修复 tool_use/tool_result 配对问题：

### 问题场景

```
正常配对：
  assistant: [tool_use(id=X)]
  user: [tool_result(tool_use_id=X)]

异常 1：tool_use 没有对应的 tool_result（流中断）
  assistant: [tool_use(id=X)]
  user: [text("hello")]  ← 没有 tool_result

异常 2：tool_result 没有对应的 tool_use（会话恢复时历史被截断）
  user: [tool_result(tool_use_id=X)]  ← 对应的 assistant 消息已被压缩删除

异常 3：跨消息重复 tool_use ID（orphan handler 多次运行）
  assistant1: [tool_use(id=X)]
  user1: [tool_result(tool_use_id=X)]
  assistant2: [tool_use(id=X)]  ← 重复 ID
  user2: [tool_result(tool_use_id=X)]  ← 重复 ID
```

### 修复策略

```typescript
// 异常 1：插入合成的 tool_result
const syntheticBlocks: ToolResultBlockParam[] = missingIds.map(id => ({
  type: 'tool_result',
  tool_use_id: id,
  content: '[Tool result missing due to internal error]',  // SYNTHETIC_TOOL_RESULT_PLACEHOLDER
  is_error: true,
}))

// 异常 2：从 user 消息中删除孤立的 tool_result
content = content.filter(block => !orphanedSet.has(block.tool_use_id))

// 异常 3：从 assistant 消息中删除重复的 tool_use
const finalContent = msg.message.content.filter(block => {
  if (block.type === 'tool_use') {
    if (allSeenToolUseIds.has(block.id)) return false  // 跨消息去重
    allSeenToolUseIds.add(block.id)
  }
  return true
})
```

### 严格模式（HFI 训练数据收集）

```typescript
if (getStrictToolResultPairing()) {
  throw new Error(
    `ensureToolResultPairing: tool_use/tool_result pairing mismatch detected (strict mode). ` +
    `Refusing to repair — would inject synthetic placeholders into model context. ` +
    `See inc-4977.`
  )
}
```

HFI（Human Feedback Interface）收集训练数据时，合成的占位符会污染训练数据，所以严格模式下直接抛出异常，放弃这条轨迹。

---

## 十、完整数据流时序图

```
时间轴 →

API SSE 流:
  [message_start]
  [content_block_start index=0 type=text]
  [content_block_delta index=0 text_delta="我来"]
  [content_block_delta index=0 text_delta="帮你"]
  [content_block_stop index=0]                    → yield AssistantMessage{content:[text]}
  [content_block_start index=1 type=tool_use name=FileEdit]
  [content_block_delta index=1 input_json_delta='{"file']
  [content_block_delta index=1 input_json_delta='_path":']
  [content_block_delta index=1 input_json_delta='"src/foo.ts"...}']
  [content_block_stop index=1]                    → JSON.parse → yield AssistantMessage{content:[text,tool_use]}
  [message_delta stop_reason=tool_use]            → mutation: lastMsg.stop_reason = 'tool_use'
  [message_stop]

query.ts 消费:
  收到 AssistantMessage{content:[text]}           → UI 渲染文本
  收到 AssistantMessage{content:[text,tool_use]}  → 检测到 tool_use → 执行工具
  工具执行完成 → 追加 tool_result UserMessage
  继续下一轮 API 调用
```
