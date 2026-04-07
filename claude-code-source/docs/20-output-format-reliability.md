# 返回结果格式保证与解析可靠性深度解析

## 核心问题

大模型输出本质上是**概率性文本流**，存在三类可靠性挑战：

1. **格式不符**：模型没有按要求的 JSON/结构输出
2. **解析断层**：SSE 流中途断开，内容不完整
3. **片段不全**：工具参数 JSON 分片拼接后解析失败

Claude Code 用多层机制解决这三类问题。

---

## 一、强制结构化输出：SyntheticOutputTool

### 核心机制

```typescript
// tools/SyntheticOutputTool/SyntheticOutputTool.ts
// 当需要固定格式输出时，注入一个特殊工具
// 模型被强制调用这个工具来"返回"结果

export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'

// 工具的 prompt 明确告诉模型：
// "You MUST call this tool exactly once at the end of your response
//  to provide the structured output."
```

### 工作原理

```
SDK 调用方传入 jsonSchema
    │
    ▼
createSyntheticOutputTool(jsonSchema)
    │
    ├── Ajv 验证 schema 合法性
    ├── 编译 schema 为验证函数（WeakMap 缓存，避免重复编译）
    │
    └── 返回 Tool 对象：
          inputJSONSchema = 用户传入的 schema
          call(input) {
            const isValid = validateSchema(input)
            if (!isValid) {
              throw new Error(`Output does not match required schema: ${errors}`)
              // 错误会被 query.ts 捕获，作为 tool_result 返回给模型
              // 模型看到错误后会重新调用工具
            }
            return { data: 'Structured output provided successfully' }
          }
```

### 双重保障：Stop Hook 强制执行

```typescript
// utils/hooks/hookHelpers.ts
registerStructuredOutputEnforcement(setAppState, sessionId)
    │
    └── addFunctionHook(
          setAppState,
          sessionId,
          'Stop',           // 在每次 stop_reason=end_turn 时触发
          '',               // 无 matcher，对所有 stop 生效
          messages => hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME),
          // 检查：是否已经成功调用了 StructuredOutput 工具？
          `You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool to complete this request. Call this tool now.`,
          // 如果没有调用，注入这条消息，强制模型再次尝试
          { timeout: 5000 }
        )
```

### 完整流程

```
用户调用 SDK，传入 jsonSchema
    │
    ▼
main.tsx 创建 SyntheticOutputTool（含 schema 验证）
注册 Stop Hook（检查工具是否被调用）
    │
    ▼
query() → API 调用
    │
    ├── 模型正常调用 StructuredOutput({ ...data })
    │     ├── Ajv 验证通过 → 返回成功
    │     └── Ajv 验证失败 → 抛出错误 → 模型看到错误 → 重试
    │
    └── 模型忘记调用 StructuredOutput（直接 end_turn）
          │
          ▼
    Stop Hook 触发：hasSuccessfulToolCall() = false
          │
          ▼
    注入消息："You MUST call the StructuredOutput tool..."
          │
          ▼
    继续 query 循环（模型被迫调用工具）
```

### sideQuery 的 JSON Schema 强制

```typescript
// utils/sideQuery.ts
// 对于内部的"侧边查询"（记忆召回、分类器等），使用 output_format 参数

sideQuery({
  output_format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        selected_memories: { type: 'array', items: { type: 'string' } },
      },
      required: ['selected_memories'],
      additionalProperties: false,
    },
  },
  // ...
})

// API 层面的结构化输出（beta: structured-outputs）
// 模型在 API 层被强制输出符合 schema 的 JSON
// 不依赖模型的"自觉"，而是 API 服务端强制
```

---

## 二、SSE 流断层处理：非流式回退

### 问题场景

```
流式 SSE 连接中途断开：
  message_start ✓
  content_block_start[0] ✓
  content_block_delta[0] × (连接断开)
  → 内容不完整，工具参数 JSON 残缺
```

### 回退机制（`services/api/claude.ts`）

```typescript
// 流式请求失败时，自动切换到非流式请求
// 非流式请求一次性返回完整响应，不存在断层问题

// 触发条件：
// 1. FallbackTriggeredError（连续 3 次 529 后触发）
// 2. 流式连接中途断开（APIConnectionError）
// 3. 流式超时（streamWatchdogEnabled）

// 回退流程：
if (streamingFallbackOccured) {
  // 1. 对已经 yield 的不完整消息发送 tombstone（从 UI 和 transcript 删除）
  for (const msg of assistantMessages) {
    yield { type: 'tombstone', message: msg }
  }
  // 2. 重置所有状态
  newMessages.length = 0
  contentBlocks.length = 0
  // 3. 继续循环，下一次迭代使用非流式请求
}
```

### 非流式请求实现

```typescript
// executeNonStreamingRequest()
// 使用 anthropic.beta.messages.create()（无 stream: true）
// 一次性返回完整的 BetaMessage
// 超时：120s（远程）/ 300s（本地）

// 关键：非流式请求的 max_tokens 有上限
const MAX_NON_STREAMING_TOKENS = ...
const adjustedParams = adjustParamsForNonStreaming(retryParams, MAX_NON_STREAMING_TOKENS)
// 防止非流式请求因 max_tokens 过大而超时
```

### 流式空闲超时（Watchdog）

```typescript
// 防止流式连接"假死"（连接存在但不发数据）
const STREAM_IDLE_TIMEOUT_MS = 90_000  // 90 秒无数据则中止

function resetStreamIdleTimer() {
  clearTimeout(streamIdleTimer)
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    releaseStreamResources()  // 强制关闭连接
    // → 触发 APIConnectionError → withRetry 重试
  }, STREAM_IDLE_TIMEOUT_MS)
}

// 每收到一个 SSE chunk 就重置计时器
for await (const part of stream) {
  resetStreamIdleTimer()  // 收到数据，重置超时
  // ...处理 part
}
```

---

## 三、工具参数 JSON 分片拼接的可靠性

### 问题：input_json_delta 是字符串片段

```typescript
// 每个 delta 只是 JSON 字符串的一个片段
// 例如：
// delta 1: '{"file'
// delta 2: '_path": "src/'
// delta 3: 'foo.ts", "old'
// delta 4: '_string": "x"}'

// 拼接后才是完整 JSON
contentBlock.input += delta.partial_json
```

### 保障：content_block_stop 时一次性解析

```typescript
// content_block_stop 时，input 已经是完整字符串
case 'content_block_stop': {
  const m: AssistantMessage = {
    message: {
      content: normalizeContentFromAPI([contentBlock], tools, agentId),
      // normalizeContentFromAPI 内部：
      // if (block.type === 'tool_use' && typeof block.input === 'string') {
      //   block.input = JSON.parse(block.input)  // 一次性解析完整 JSON
      // }
    }
  }
  yield m
}
```

### 保障：Zod schema 验证

```typescript
// 工具调用前，validateInput() 用 Zod 验证参数
tool.validateInput(input, context)
    → tool.inputSchema.safeParse(input)
    → 如果解析失败，返回 ValidationResult { result: false, message: '...' }
    → 错误作为 tool_result 返回给模型
    → 模型看到错误后重新生成正确参数
```

### 保障：eager_input_streaming（细粒度工具流）

```typescript
// 启用后，API 在工具参数完整时才发送 input_json_delta
// 而不是逐字节发送
// 防止超大工具输入（如 FileWrite 的 content 字段）导致多分钟挂起

if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_fgts', false)) {
  base.eager_input_streaming = true
}
// 效果：input_json_delta 的粒度更粗，减少分片数量
// 但仍然是字符串拼接，只是片段更大
```

---

## 四、重试机制：withRetry 的多层保障

### 重试策略

```typescript
withRetry(getClient, operation, options)
    │
    ├── 最大重试次数：10 次（DEFAULT_MAX_RETRIES）
    │
    ├── 指数退避：
    │     delay = min(500ms * 2^(attempt-1), 32000ms) + jitter(25%)
    │     attempt 1: ~500ms
    │     attempt 2: ~1000ms
    │     attempt 3: ~2000ms
    │     ...
    │     attempt 6+: ~32000ms（32秒上限）
    │
    ├── 可重试的错误：
    │     ├── 408 Request Timeout
    │     ├── 409 Lock Timeout
    │     ├── 429 Rate Limit（非 claude.ai 订阅用户）
    │     ├── 529 Overloaded（前台查询）
    │     ├── 5xx Server Error
    │     ├── APIConnectionError（网络断开）
    │     └── OAuth 401/403（触发 token 刷新后重试）
    │
    └── 不可重试的错误：
          ├── 400 Bad Request（参数错误）
          ├── 401 Invalid API Key（非 OAuth）
          └── 后台查询的 529（避免放大效应）
```

### 529 过载的特殊处理

```typescript
// 连续 3 次 529 → 触发模型降级（fallback model）
consecutive529Errors++
if (consecutive529Errors >= MAX_529_RETRIES) {
  if (options.fallbackModel) {
    throw new FallbackTriggeredError(options.model, options.fallbackModel)
    // → query.ts 捕获，切换到 fallbackModel 重试
  }
}

// 后台查询（记忆提取、分类器等）不重试 529
// 避免在服务器过载时放大请求量
if (is529Error(error) && !shouldRetry529(options.querySource)) {
  throw new CannotRetryError(error, retryContext)
}
```

### max_tokens 上下文溢出自动调整

```typescript
// 当 input_tokens + max_tokens > context_limit 时
// API 返回 400 错误，包含具体数字
// withRetry 解析错误，自动调整 max_tokens

parseMaxTokensContextOverflowError(error)
    → { inputTokens: 188059, maxTokens: 20000, contextLimit: 200000 }

// 计算可用 token 数
const availableContext = contextLimit - inputTokens - 1000  // 1000 安全缓冲
retryContext.maxTokensOverride = Math.max(FLOOR_OUTPUT_TOKENS, availableContext)
// 下一次重试使用调整后的 max_tokens
```

---

## 五、Bundled Skills 的格式保证策略

### loop.ts：结构化解析指令

```typescript
// loop.ts 的核心设计：
// 不依赖模型"猜测"格式，而是给出精确的解析规则

buildPrompt(args) {
  return `
## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches \`^\\d+[smhd]$\`...
2. **Trailing "every" clause**: otherwise, if the input ends with \`every <N><unit>\`...
3. **Default**: otherwise, interval is \`10m\` and the entire input is the prompt.

## Interval → cron

| Interval pattern | Cron expression | Notes |
|------------------|-----------------|-------|
| \`Nm\` where N ≤ 59 | \`*/N * * * *\` | every N minutes |
...

## Action

1. Call ${CRON_CREATE_TOOL_NAME} with:
   - \`cron\`: the expression from the table above
   - \`prompt\`: the parsed prompt from above, verbatim
   - \`recurring\`: \`true\`
`
}
```

**关键设计**：
- 用**优先级顺序**消除歧义（规则 1 > 规则 2 > 规则 3）
- 用**精确正则**定义匹配条件（`^\\d+[smhd]$`）
- 用**转换表格**定义输出格式（interval → cron expression）
- 用**反例**防止误匹配（`check every PR` 不触发规则 2）

### batch.ts：阶段化执行防止跳步

```typescript
// batch.ts 的核心设计：
// 将复杂任务分解为强制顺序的阶段

`## Phase 1: Research and Plan (Plan Mode)
Call the \`${ENTER_PLAN_MODE_TOOL_NAME}\` tool now to enter plan mode...
// 强制进入计划模式，防止直接执行

## Phase 2: Spawn Workers (After Plan Approval)
Once the plan is approved, spawn one background agent per work unit...
// 明确前置条件：计划必须被批准

## Phase 3: Track Progress
After launching all workers, render an initial status table...
// 明确输出格式：Markdown 表格`
```

**关键设计**：
- **计划模式强制**：`EnterPlanModeTool` 让用户审批后才执行
- **阶段前置条件**：每个阶段明确说明"何时"才能进入
- **输出格式规定**：明确要求 Markdown 表格格式

### simplify.ts：并行 Agent 的结果聚合

```typescript
// simplify.ts 的核心设计：
// 3 个并行 Agent，每个有明确的检查清单

`### Agent 1: Code Reuse Review
For each change:
1. **Search for existing utilities**...
2. **Flag any new function that duplicates**...
3. **Flag any inline logic**...

### Agent 2: Code Quality Review
1. **Redundant state**...
2. **Parameter sprawl**...
...

## Phase 3: Fix Issues
Wait for all three agents to complete. Aggregate their findings and fix each issue directly.
If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.`
```

**关键设计**：
- **明确等待**：`Wait for all three agents to complete`（防止提前汇总）
- **处理假阳性**：`note it and move on`（防止模型陷入争论循环）
- **简洁汇总**：`briefly summarize what was fixed`（防止冗长输出）

### debug.ts：动态内容注入 + 格式约束

```typescript
// debug.ts 的核心设计：
// 将实际的调试日志内容注入到 prompt 中
// 而不是让模型去"猜"日志在哪里

async getPromptForCommand(args) {
  // 1. 实际读取日志文件（tail 64KB）
  const tail = buffer.toString('utf-8', 0, bytesRead)
    .split('\n')
    .slice(-DEFAULT_DEBUG_LINES_READ)
    .join('\n')

  // 2. 将真实内容注入 prompt
  const prompt = `
## Session Debug Log
The debug log for the current session is at: \`${debugLogPath}\`
${logInfo}  // ← 实际的日志内容

## Instructions
1. Review the user's issue description
2. The last ${DEFAULT_DEBUG_LINES_READ} lines show the debug file format.
   Look for [ERROR] and [WARN] entries...
3. Consider launching the ${CLAUDE_CODE_GUIDE_AGENT_TYPE} subagent...
4. Explain what you found in plain language
5. Suggest concrete fixes or next steps
`
}
```

**关键设计**：
- **预加载数据**：不让模型自己去读文件，直接注入内容
- **格式约束**：明确的 5 步指令，防止模型自由发挥
- **工具限制**：`allowedTools: ['Read', 'Grep', 'Glob']`（只读，防止误操作）

---

## 六、格式保证的层次总结

```
层次 1：API 层强制（最强）
    └── output_format: { type: 'json_schema', schema: {...} }
        → API 服务端强制，模型无法绕过
        → 用于：记忆召回选择、分类器、内部 sideQuery

层次 2：工具调用强制（强）
    └── SyntheticOutputTool + Stop Hook
        → 模型必须调用工具才能"完成"任务
        → Ajv 验证 schema，失败则重试
        → 用于：SDK 结构化输出、hook 验证

层次 3：Zod 验证（中）
    └── tool.validateInput() → inputSchema.safeParse()
        → 工具参数不符合 schema 时返回错误给模型
        → 模型看到错误后重新生成
        → 用于：所有工具调用

层次 4：Prompt 工程（弱但通用）
    └── 精确的解析规则 + 优先级顺序 + 示例 + 反例
        → 依赖模型理解和遵循指令
        → 用于：Bundled Skills（loop、batch、simplify 等）

层次 5：重试兜底（最后防线）
    └── withRetry（最多 10 次）+ 非流式回退
        → 网络断层、服务器过载时自动重试
        → 流式失败时切换非流式（完整响应）
```

---

## 七、解析不全的具体防护

### 问题 1：工具参数 JSON 不完整

```
原因：流式连接在 input_json_delta 中途断开
防护：
  1. content_block_stop 时才解析 JSON（不提前解析）
  2. 流断开 → withRetry 重试 → 新请求从头开始
  3. 非流式回退 → 一次性返回完整响应
```

### 问题 2：模型输出截断（max_tokens 不足）

```
原因：stop_reason = 'max_tokens'（输出被截断）
防护：
  1. query.ts 检测 stop_reason = 'max_tokens'
  2. 触发 max_output_tokens 恢复逻辑（最多 3 次）
  3. 增加 max_tokens 重试
  4. 或触发 autocompact 压缩历史后重试
```

### 问题 3：thinking block 签名验证失败

```
原因：流式回退时，thinking block 的 signature 不完整
防护：
  1. 检测到 streamingFallbackOccured
  2. 对所有已 yield 的 assistantMessages 发送 tombstone
  3. 重置 contentBlocks 数组
  4. 重新请求（不带不完整的 thinking blocks）
```

### 问题 4：工具结果过大导致上下文溢出

```
原因：FileRead 返回 100KB 文件，超出 context window
防护：
  1. maxResultSizeChars 限制（每个工具有上限）
  2. 超出时持久化到磁盘，返回预览 + 文件路径
  3. applyToolResultBudget() 对所有工具结果总量限制
```

### 问题 5：sideQuery 返回非 JSON

```
原因：模型没有遵循 output_format 指令
防护：
  1. output_format 是 API 层强制，不依赖模型
  2. 即使模型"想"输出文本，API 也会强制 JSON 格式
  3. 解析失败时 sideQuery 返回空结果（findRelevantMemories 返回 []）
```
