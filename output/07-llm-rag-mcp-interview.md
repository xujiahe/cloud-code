# LLM + RAG + MCP 全流程面试题

> 涵盖：JSON 解析与校验、MCP 调用、结果处理、流式输出等核心环节

---

## 一、整体架构与流程

### Q1：描述一个完整的 LLM + RAG + MCP 请求链路

**参考答案：**

```
用户输入
  → 意图识别 / Query 改写
  → RAG 检索（向量召回 + 重排序）
  → Prompt 构建（注入上下文）
  → LLM 推理（流式输出）
  → 工具调用决策（Tool Call / MCP）
  → MCP Server 执行工具
  → 结果注入 → 二次推理
  → 最终响应返回用户
```

关键点：
- RAG 负责知识增强，解决 LLM 知识截止问题
- MCP（Model Context Protocol）负责工具调用标准化
- 流式输出贯穿整个推理阶段，降低首字节延迟

---

### Q2：RAG 和 Fine-tuning 的核心区别是什么？什么场景选哪个？

**参考答案：**

| 维度 | RAG | Fine-tuning |
|------|-----|-------------|
| 知识更新 | 实时，改索引即可 | 需重新训练 |
| 成本 | 低（推理时检索） | 高（训练成本） |
| 幻觉控制 | 有来源可溯源 | 较难控制 |
| 适用场景 | 知识库问答、文档检索 | 风格迁移、特定任务专精 |

选择原则：知识频繁变化 → RAG；需要模型行为/风格改变 → Fine-tuning；两者可结合。

---

## 二、JSON 解析与校验

### Q3：LLM 输出的 JSON 为什么经常解析失败？如何处理？

**参考答案：**

常见失败原因：
1. 模型输出了 markdown 代码块包裹（` ```json ... ``` `）
2. 尾部多余逗号（trailing comma）
3. 字符串中未转义的换行符或引号
4. 输出被截断（max_tokens 不足）
5. 模型"幻觉"出非法字段

处理策略：

```typescript
function extractJSON(raw: string): unknown {
  // 1. 去掉 markdown 代码块
  const stripped = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  
  // 2. 尝试直接解析
  try {
    return JSON.parse(stripped);
  } catch {}

  // 3. 提取第一个 { } 或 [ ] 块
  const match = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }

  // 4. 使用容错解析库（如 json5、jsonrepair）
  // return JSON5.parse(stripped);
  throw new Error('JSON parse failed');
}
```

---

### Q4：如何对 LLM 返回的 JSON 做 Schema 校验？

**参考答案：**

推荐使用 **Zod** 或 **JSON Schema + ajv**：

```typescript
import { z } from 'zod';

const ToolCallSchema = z.object({
  tool_name: z.string().min(1),
  parameters: z.record(z.unknown()),
  reasoning: z.string().optional(),
});

type ToolCall = z.infer<typeof ToolCallSchema>;

function validateToolCall(raw: unknown): ToolCall {
  const result = ToolCallSchema.safeParse(raw);
  if (!result.success) {
    // 将 zod 错误格式化后反馈给 LLM 重试
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }
  return result.data;
}
```

进阶：校验失败时将错误信息拼回 prompt，让 LLM 自我修正（self-correction loop），最多重试 N 次。

---

### Q5：如何用 Structured Output / Function Calling 从根本上避免 JSON 解析问题？

**参考答案：**

OpenAI `response_format: { type: "json_schema" }` 或 `tools` 参数可强制模型输出合法 JSON：

```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'tool_call',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          parameters: { type: 'object' },
        },
        required: ['tool_name', 'parameters'],
        additionalProperties: false,
      },
    },
  },
});
```

`strict: true` 时模型输出保证符合 schema，解析不会失败。代价是 schema 有限制（不支持 oneOf 等复杂结构）。

---

## 三、MCP 调用

### Q6：MCP 是什么？解决了什么问题？

**参考答案：**

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，标准化了 LLM 与外部工具/数据源的交互方式。

解决的问题：
- 每个工具都要写一套 LLM 适配代码，重复且不可复用
- 工具描述格式不统一，模型理解质量参差不齐
- 权限、安全边界难以统一管理

核心概念：
```
MCP Host（LLM 应用）
  ↕ MCP Protocol（JSON-RPC 2.0）
MCP Server（工具提供方）
  - Tools：可执行的函数
  - Resources：可读取的数据
  - Prompts：预定义的提示模板
```

---

### Q7：MCP 工具调用的完整流程是什么？

**参考答案：**

```
1. 初始化阶段
   Client → initialize → Server
   Server 返回 capabilities（支持哪些 tools/resources）

2. 工具发现
   Client → tools/list → Server
   Server 返回工具列表（name, description, inputSchema）

3. LLM 决策
   将工具列表注入 system prompt 或 tools 参数
   LLM 输出 tool_use 块，包含 tool_name + input

4. 工具执行
   Client → tools/call { name, arguments } → Server
   Server 执行并返回 { content: [...], isError: false }

5. 结果注入
   将 tool result 作为新消息追加
   再次调用 LLM 生成最终回复
```

---

### Q8：MCP 调用中如何处理超时和错误重试？

**参考答案：**

```typescript
async function callMCPTool(
  client: MCPClient,
  toolName: string,
  args: Record<string, unknown>,
  options = { timeout: 30000, maxRetries: 3 }
): Promise<MCPToolResult> {
  let lastError: Error;

  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        client.callTool({ name: toolName, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP tool timeout')), options.timeout)
        ),
      ]);

      if (result.isError) {
        // MCP 协议层错误，不重试，直接返回给 LLM 处理
        return result;
      }
      return result;

    } catch (err) {
      lastError = err as Error;
      // 指数退避
      if (attempt < options.maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 500);
      }
    }
  }

  throw lastError!;
}
```

区分两类错误：
- **MCP 协议错误**（`isError: true`）：工具执行失败，返回给 LLM 让其决策
- **传输层错误**（网络超时等）：重试，超限后上报

---

### Q9：如何防止 LLM 调用恶意或未授权的 MCP 工具？

**参考答案：**

1. **工具白名单**：只向 LLM 暴露允许调用的工具列表
2. **参数校验**：对 LLM 传入的 arguments 做严格 schema 校验，拒绝异常参数
3. **沙箱隔离**：MCP Server 在独立进程/容器中运行，限制文件系统和网络访问
4. **Human-in-the-loop**：高风险操作（删除、支付）需用户二次确认
5. **审计日志**：记录所有工具调用，包含调用方、参数、结果

```typescript
const ALLOWED_TOOLS = new Set(['search_web', 'read_file', 'run_query']);

function filterTools(tools: MCPTool[]): MCPTool[] {
  return tools.filter(t => ALLOWED_TOOLS.has(t.name));
}
```

---

## 四、流式处理

### Q10：LLM 流式输出的底层机制是什么？前端如何消费？

**参考答案：**

底层：Server-Sent Events（SSE）或 WebSocket，服务端逐 token 推送。

OpenAI SSE 格式：
```
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}
data: {"choices":[{"delta":{"content":" world"},"index":0}]}
data: [DONE]
```

前端消费（fetch + ReadableStream）：

```typescript
async function streamChat(prompt: string, onChunk: (text: string) => void) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
    headers: { 'Content-Type': 'application/json' },
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const chunk = JSON.parse(line.slice(6));
      const text = chunk.choices?.[0]?.delta?.content ?? '';
      if (text) onChunk(text);
    }
  }
}
```

---

### Q11：流式输出中如何检测并解析 Tool Call？

**参考答案：**

Tool Call 在流式中是分片到达的，需要累积拼接：

```typescript
interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsBuffer: string;
}

const toolCalls = new Map<number, ToolCallAccumulator>();

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;

  // 累积 tool_calls 分片
  for (const tc of delta.tool_calls ?? []) {
    if (!toolCalls.has(tc.index)) {
      toolCalls.set(tc.index, { id: tc.id, name: tc.function.name, argumentsBuffer: '' });
    }
    toolCalls.get(tc.index)!.argumentsBuffer += tc.function.arguments ?? '';
  }

  // finish_reason === 'tool_calls' 时解析完整参数
  if (chunk.choices[0]?.finish_reason === 'tool_calls') {
    for (const [, tc] of toolCalls) {
      const args = JSON.parse(tc.argumentsBuffer); // 此时才是完整 JSON
      await executeTool(tc.name, args);
    }
  }
}
```

---

### Q12：流式场景下如何实现"边流式输出边执行工具"？

**参考答案：**

这是 **Streaming + Parallel Tool Execution** 模式：

```
流式 token → 实时渲染给用户
                ↓
         检测到 tool_call 开始
                ↓
         继续流式（渲染思考过程）
                ↓
         finish_reason = tool_calls
                ↓
         并行执行所有工具（Promise.all）
                ↓
         注入结果，开启第二轮流式
```

关键：工具执行期间可以展示 loading 状态，不阻塞 UI 渲染。

```typescript
// 并行执行多个工具
const results = await Promise.allSettled(
  toolCalls.map(tc => callMCPTool(client, tc.name, tc.arguments))
);

// 将结果追加为 tool 消息
const toolMessages = results.map((r, i) => ({
  role: 'tool' as const,
  tool_call_id: toolCalls[i].id,
  content: r.status === 'fulfilled'
    ? JSON.stringify(r.value.content)
    : `Error: ${(r.reason as Error).message}`,
}));
```

---

## 五、RAG 检索

### Q13：向量检索召回质量差怎么排查？

**参考答案：**

排查维度：

1. **Embedding 模型**：是否与文档语言匹配？中文文档用中文 embedding 模型
2. **分块策略**：chunk 太大语义稀释，太小上下文丢失；推荐 512~1024 token + overlap
3. **相似度阈值**：threshold 设太高导致召回为空，太低引入噪声
4. **查询改写**：原始 query 太短或口语化，用 HyDE（假设文档嵌入）或 query expansion
5. **重排序**：召回 top-K 后用 cross-encoder reranker 精排

```typescript
// HyDE：先让 LLM 生成假设答案，用假设答案做检索
async function hydeSearch(query: string): Promise<Document[]> {
  const hypothetical = await llm.complete(
    `请根据以下问题生成一段假设性的答案：\n${query}`
  );
  return vectorStore.search(hypothetical, { topK: 10 });
}
```

---

### Q14：如何评估 RAG 系统的质量？

**参考答案：**

核心指标（RAGAS 框架）：

| 指标 | 含义 | 计算方式 |
|------|------|----------|
| Faithfulness | 答案是否忠实于检索内容 | LLM 判断答案每句话是否有来源支撑 |
| Answer Relevancy | 答案是否回答了问题 | 答案 embedding 与问题的相似度 |
| Context Precision | 检索内容是否都有用 | 有用 chunk / 总 chunk 数 |
| Context Recall | 相关内容是否都被检索到 | 需要 ground truth |

---

## 六、综合场景题

### Q15：设计一个支持多轮对话 + 工具调用 + 流式输出的 Agent，说明关键设计决策

**参考答案：**

```
核心循环（ReAct 模式）：
  while not done:
    stream = llm.stream(messages)
    for chunk in stream:
      if chunk.is_text: yield chunk          # 实时输出
      if chunk.is_tool_call: buffer tool     # 缓冲工具调用
    
    if tool_calls:
      results = await parallel_execute(tool_calls)
      messages.append(tool_results)
      continue                               # 再次推理
    else:
      done = True
```

关键决策：

1. **消息历史管理**：超出 context window 时用滑动窗口或摘要压缩
2. **工具调用幂等性**：同一工具调用失败重试时需保证幂等
3. **循环检测**：检测 LLM 是否在重复调用同一工具，设置最大步数上限（如 10 步）
4. **流式中断**：用户取消时需 abort stream 并清理 MCP 连接
5. **错误降级**：工具失败时告知 LLM，让其尝试其他路径或直接回答

```typescript
const MAX_STEPS = 10;
let steps = 0;

while (steps++ < MAX_STEPS) {
  const { text, toolCalls, finishReason } = await streamAndCollect(messages);
  
  if (finishReason === 'stop') break;
  
  if (toolCalls.length === 0) break;
  
  // 循环检测
  const callSignature = JSON.stringify(toolCalls.map(t => t.name + JSON.stringify(t.args)));
  if (seenCalls.has(callSignature)) {
    messages.push({ role: 'user', content: '请不要重复相同的工具调用，尝试其他方式。' });
    continue;
  }
  seenCalls.add(callSignature);
  
  const results = await Promise.all(toolCalls.map(tc => executeTool(tc)));
  messages.push(...formatToolResults(results));
}
```

---

*共 15 题，覆盖架构设计、JSON 处理、MCP 协议、流式解析、RAG 优化等核心面试考点。*


---

## 七、SSE 与流式传输细节

### Q16：为什么 LLM 服务普遍选择 SSE 而不是 WebSocket？

**参考答案：**

LLM 推理是典型的**单向服务端推送**场景，SSE 天然契合：

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 协议 | 基于 HTTP/1.1，无需升级 | 需要 Upgrade 握手 |
| 方向 | 单向（server → client） | 全双工 |
| 断线重连 | 浏览器原生支持（Last-Event-ID） | 需自行实现 |
| CDN/代理 | 兼容性好 | 很多中间件不支持 |
| 扩展性 | 无状态，水平扩展简单 | 有状态长连接，扩容复杂 |
| 适用场景 | LLM token 推送、通知 | 游戏、实时协作 |

另一种方案是 **HTTP Chunked Transfer Encoding**（不带 SSE 事件格式，直接流式 body），本质相同，少了事件语义，适合非浏览器客户端。

---

### Q17：SSE 的 `data:`、`event:`、`id:`、`retry:` 字段分别有什么作用？

**参考答案：**

```
id: 42                        # 事件 ID，断线重连时通过 Last-Event-ID 恢复
event: token                  # 事件类型，默认 message，客户端可按类型监听
data: {"content":"Hello"}     # 实际数据，多行 data 会被拼接（加换行符）
retry: 3000                   # 告诉客户端断线后等多少毫秒再重连

                              # 空行 = 事件结束，触发一次 onmessage
```

LLM 场景常见设计：
```
event: delta          # 普通 token
event: tool_call      # 工具调用开始
event: tool_result    # 工具结果
event: done           # 推理结束
data: [DONE]          # OpenAI 风格的结束标记
```

客户端按事件类型分发：
```typescript
const es = new EventSource('/api/stream');
es.addEventListener('tool_call', (e) => handleToolCall(JSON.parse(e.data)));
es.addEventListener('done', () => es.close());
```

---

### Q18：SSE 断线重连机制是怎么工作的？LLM 场景下有什么坑？

**参考答案：**

浏览器 `EventSource` 断线后会自动重连，并在请求头带上：
```
Last-Event-ID: 42
```

服务端根据这个 ID 从断点续传。

**LLM 场景的坑：**

1. **推理无法暂停续传**：LLM 推理是一次性的，断线后服务端已经推完的 token 无法重放。需要服务端缓存已推送内容，重连时补发。

2. **ID 设计**：每个 token chunk 都要分配递增 ID，否则重连无法定位断点。

3. **代理超时**：Nginx 默认 `proxy_read_timeout 60s`，长推理会被切断。需要：
   ```nginx
   proxy_read_timeout 300s;
   proxy_buffering off;        # 关键！否则代理会缓冲 SSE 数据
   X-Accel-Buffering: no;
   ```

4. **心跳保活**：推理慢时中间可能没有数据，连接被中间件断开。需要定期发送注释行：
   ```
   : ping
   
   ```

---

### Q19：前端用 `fetch` 消费 SSE 和用 `EventSource` 有什么区别？LLM SDK 为什么用 fetch？

**参考答案：**

| 维度 | EventSource | fetch + ReadableStream |
|------|-------------|----------------------|
| 请求方法 | 只支持 GET | 支持 POST |
| 自定义 Header | 不支持 | 支持（Authorization 等） |
| 请求体 | 无 | 支持（发送 prompt） |
| 自动重连 | 有 | 需自行实现 |
| 浏览器支持 | 原生 | 原生 |

LLM 请求需要 POST + Authorization header，`EventSource` 做不到，所以 OpenAI SDK、Vercel AI SDK 都用 `fetch`：

```typescript
const response = await fetch('/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ ...params, stream: true }),
  signal: abortController.signal,  // 支持取消
});

// 手动解析 SSE 格式
const reader = response.body!.getReader();
```

---

### Q20：流式输出中如何正确处理中文等多字节字符的截断问题？

**参考答案：**

`TextDecoder` 默认每次 decode 一个 chunk，UTF-8 多字节字符（中文 3 字节）可能被 chunk 边界截断，导致乱码。

**错误做法：**
```typescript
const decoder = new TextDecoder();
// 每次 decode 独立 chunk，多字节字符截断时会出现 ?
const text = decoder.decode(value);
```

**正确做法：** 使用 `stream: true` 选项，让 decoder 保留不完整字节：
```typescript
const decoder = new TextDecoder('utf-8', { fatal: false });

// decode 时传 stream: true，不完整的多字节序列会被缓冲到下次
const text = decoder.decode(value, { stream: true });

// 最后一个 chunk 不传 stream: true，flush 剩余缓冲
const final = decoder.decode(); // 无参数 = flush
```

---

### Q21：如何实现流式输出的"取消"功能？取消后服务端需要做什么？

**参考答案：**

客户端用 `AbortController`：
```typescript
const controller = new AbortController();

// 用户点击停止
stopButton.onclick = () => controller.abort();

const response = await fetch('/api/chat', {
  signal: controller.signal,
  // ...
});

try {
  for await (const chunk of parseSSE(response.body!)) {
    render(chunk);
  }
} catch (e) {
  if (e.name === 'AbortError') {
    console.log('用户取消');
  }
}
```

服务端需要：
1. **检测连接断开**：监听 `request.signal.aborted` 或 `close` 事件
2. **中止 LLM 推理**：调用 LLM SDK 的 abort，避免浪费算力
3. **释放 MCP 连接**：正在执行的工具调用需要清理

```typescript
// Node.js / Hono 示例
app.post('/api/chat', async (c) => {
  const abortController = new AbortController();
  
  c.req.raw.signal.addEventListener('abort', () => {
    abortController.abort(); // 级联取消 LLM 请求
  });

  const stream = await openai.chat.completions.create({
    ...params,
    stream: true,
  }, { signal: abortController.signal });

  return streamSSE(c, async (sse) => {
    for await (const chunk of stream) {
      if (abortController.signal.aborted) break;
      await sse.writeData(chunk);
    }
  });
});
```

---

### Q22：大量并发流式请求时，服务端如何做背压（Backpressure）控制？

**参考答案：**

背压问题：LLM 推理速度 > 客户端消费速度时，服务端缓冲区会撑爆。

Node.js Streams 内置背压机制：
```typescript
// 使用 TransformStream，当下游消费慢时自动暂停上游
const { readable, writable } = new TransformStream({
  highWaterMark: 10, // 缓冲区最多 10 个 chunk
});

const writer = writable.getWriter();

for await (const chunk of llmStream) {
  // write 返回 Promise，缓冲区满时会 await（背压生效）
  await writer.write(encodeSSE(chunk));
}
await writer.close();

return new Response(readable, {
  headers: { 'Content-Type': 'text/event-stream' },
});
```

并发控制：
```typescript
// 限制同时推理的请求数，超出排队
import PQueue from 'p-queue';
const inferenceQueue = new PQueue({ concurrency: 20 });

app.post('/api/chat', (c) => {
  return inferenceQueue.add(() => handleChat(c));
});
```

---

### Q23：Token 计费和流式输出的关系——流式请求的 usage 信息在哪里？

**参考答案：**

流式模式下，OpenAI 默认**不在每个 chunk 里返回 usage**，需要显式开启：

```typescript
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  stream: true,
  stream_options: { include_usage: true }, // 开启后最后一个 chunk 包含 usage
});

let usage = null;
for await (const chunk of stream) {
  if (chunk.usage) {
    usage = chunk.usage; // 最后一个 chunk：{ prompt_tokens, completion_tokens, total_tokens }
  }
  // 处理 delta...
}
```

注意：最后一个包含 usage 的 chunk，其 `choices` 数组为空，需要判断后再处理。

实际计费建议在服务端统计，不信任客户端上报的 token 数。


---

## 八、MCP vs Skills 及客户端上下文通信

### Q24：MCP 和 Skills（Function Calling）的本质区别是什么？

**参考答案：**

| 维度 | Skills / Function Calling | MCP |
|------|--------------------------|-----|
| 定义方式 | JSON Schema 写在请求参数里 | 独立进程/服务，通过协议发现 |
| 执行位置 | 应用层硬编码调用 | MCP Server 独立运行 |
| 可复用性 | 与应用强耦合 | 任何 MCP Host 都能接入 |
| 生命周期 | 无，随请求存在 | 有（initialize/shutdown） |
| 传输层 | 无（只是 prompt 约定） | stdio / HTTP+SSE / WebSocket |
| 状态管理 | 无状态 | 可有会话状态 |
| 标准化 | 各家格式不同 | 统一协议规范 |

**类比理解：**
- Skills = 餐厅菜单（告诉你有什么菜）
- MCP = 标准化厨房接口（任何餐厅都能接入同一套点餐系统）

落地实践上的选择：
- 工具逻辑简单、只在一个应用内用 → Function Calling 够了
- 工具需要跨应用复用、有独立部署需求、需要权限隔离 → MCP
- 工具需要访问本地文件系统/进程 → 必须 MCP（stdio transport）

---

### Q25：MCP 的三种 Transport 各适合什么场景？

**参考答案：**

```
1. stdio（标准输入输出）
   Host 启动子进程，通过 stdin/stdout 通信
   适合：本地工具（文件操作、代码执行、本地数据库）
   优点：无网络开销，天然沙箱隔离
   缺点：只能本地，无法远程共享

2. HTTP + SSE（Streamable HTTP）
   Client POST 发请求，Server SSE 推结果
   适合：远程工具服务、SaaS 工具、多用户共享
   优点：标准 HTTP，CDN/代理友好，易于部署
   缺点：需要处理认证、会话管理

3. WebSocket（较少见）
   适合：需要双向实时通信的工具（如实时监控、订阅事件）
```

实际项目中最常见的组合：
- IDE 插件类（Cursor/Kiro）→ stdio，启动本地 MCP Server 子进程
- 云端 Agent 平台 → HTTP+SSE，工具作为微服务部署

---

### Q26：客户端的上下文信息（用户身份、当前文件、选中内容）如何传递给 MCP Server？

**参考答案：**

这是落地中最常见的痛点，有以下几种方案：

**方案一：arguments 注入（最简单）**

每次 `tools/call` 时把上下文塞进参数，LLM 负责填充：

```typescript
// LLM 生成的 tool call
{
  "name": "edit_file",
  "arguments": {
    "file_path": "/src/index.ts",  // 从对话上下文得知
    "user_id": "u_123",            // 由系统 prompt 注入
    "content": "..."
  }
}
```

缺点：敏感信息（token）暴露给 LLM，且每次都要传。

---

**方案二：initialize 阶段传递静态上下文**

```typescript
// MCP 握手时传递客户端信息
await client.connect(transport);
// initialize 请求中的 clientInfo
{
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "my-ide",
      "version": "1.0.0"
    },
    "capabilities": { ... }
  }
}
```

但 `clientInfo` 字段有限，不适合传业务上下文。

---

**方案三：HTTP Transport 层注入（推荐用于认证）**

```typescript
// 客户端在 HTTP header 里带 token
const transport = new SSEClientTransport(new URL('https://mcp.example.com/sse'), {
  requestInit: {
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'X-Workspace-Id': workspaceId,
    },
  },
});

// 服务端从 header 提取，绑定到会话
app.post('/mcp', authenticate, async (req, res) => {
  const userId = req.user.id; // 从 JWT 解析
  const session = getOrCreateSession(userId);
  await session.handleRequest(req.body);
});
```

---

**方案四：MCP Roots 机制（传递工作区信息）**

客户端声明自己能提供哪些"根路径"，Server 据此限制文件访问范围：

```typescript
// 客户端声明 roots
client.setRoots([
  { uri: 'file:///workspace/my-project', name: 'My Project' },
]);

// Server 收到 roots/list 请求时返回
// Server 的文件操作工具只能访问这些路径
```

---

**方案五：Sampling 回调（Server 反向请求 Client）**

Server 执行工具时发现需要更多信息，通过 `sampling/createMessage` 反向请求 Client 提供：

```
Client → tools/call(search_code) → Server
Server 发现需要当前选中的代码
Server → sampling/createMessage → Client
Client 返回当前编辑器选中内容
Server 继续执行，返回结果
```

```typescript
// Server 端发起 sampling
const result = await server.requestSampling({
  messages: [{ role: 'user', content: { type: 'text', text: '请提供当前选中的代码' } }],
  maxTokens: 1024,
});
```

---

### Q27：MCP Server 如何管理多用户会话隔离？

**参考答案：**

HTTP Transport 下，每个客户端连接对应一个 Session，需要隔离：

```typescript
interface MCPSession {
  id: string;
  userId: string;
  context: Map<string, unknown>;
  createdAt: number;
}

const sessions = new Map<string, MCPSession>();

// SSE 连接建立时创建 session
app.get('/sse', authenticate, (req, res) => {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    userId: req.user.id,
    context: new Map(),
    createdAt: Date.now(),
  });

  // 把 sessionId 告诉客户端（通过 SSE endpoint 返回）
  res.setHeader('Content-Type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

  req.on('close', () => {
    sessions.delete(sessionId); // 连接断开时清理
  });
});

// POST 请求带上 sessionId
app.post('/message', (req, res) => {
  const session = sessions.get(req.headers['x-session-id'] as string);
  if (!session) return res.status(401).end();
  
  // 工具执行时只能访问该用户的资源
  handleMCPRequest(req.body, session);
});
```

Session 过期清理：
```typescript
// 定期清理超时 session（30 分钟无活动）
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 60_000);
```

---

### Q28：IDE 插件（如 Cursor/Kiro）通过 stdio 启动 MCP Server 时，如何把编辑器上下文传给工具？

**参考答案：**

stdio 模式下没有 HTTP header，上下文传递方式：

**1. 环境变量（启动时注入静态配置）**
```json
// mcp.json 配置
{
  "mcpServers": {
    "my-tool": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/project",
        "USER_TOKEN": "${env:MY_API_TOKEN}"
      }
    }
  }
}
```

```typescript
// Server 端读取
const workspaceRoot = process.env.WORKSPACE_ROOT;
```

**2. 命令行参数**
```json
{
  "args": ["./mcp-server.js", "--workspace", "/path/to/project"]
}
```

**3. 动态上下文通过 tool arguments 传递**

IDE 在构建 LLM 请求时，把当前编辑器状态注入 system prompt，LLM 再把相关信息填入 tool arguments：

```
System Prompt:
  当前打开的文件：/src/index.ts
  光标位置：第 42 行
  选中内容：`const foo = bar()`

→ LLM 调用工具时自动填入这些信息
```

**4. MCP Resources（推荐）**

IDE 作为 MCP Client，把编辑器状态暴露为 Resources，Server 可以主动读取：

```typescript
// IDE 作为 Client 暴露资源
client.setResourceHandler('editor://current-file', () => ({
  contents: [{
    uri: 'editor://current-file',
    mimeType: 'text/plain',
    text: editor.getCurrentFileContent(),
  }],
}));

// MCP Server 工具执行时读取
const file = await client.readResource('editor://current-file');
```

---

### Q29：MCP 工具的 inputSchema 设计有哪些最佳实践？

**参考答案：**

好的 schema 设计直接影响 LLM 的调用准确率：

```typescript
// 差的设计：描述模糊，参数过于宽泛
{
  name: "process",
  description: "处理数据",
  inputSchema: {
    type: "object",
    properties: {
      data: { type: "string" },
      options: { type: "object" }
    }
  }
}

// 好的设计：描述精确，枚举明确，有示例
{
  name: "search_codebase",
  description: "在代码库中搜索符号或文本。适合查找函数定义、类声明、变量使用位置。不适合全文语义搜索。",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，支持正则表达式。例如：'function handleAuth' 或 'import.*from.*react'"
      },
      search_type: {
        type: "string",
        enum: ["exact", "regex", "fuzzy"],
        description: "exact=精确匹配, regex=正则, fuzzy=模糊匹配",
        default: "exact"
      },
      file_pattern: {
        type: "string",
        description: "限定搜索的文件范围，glob 格式。例如：'**/*.ts' 只搜 TypeScript 文件",
        default: "**/*"
      },
      max_results: {
        type: "number",
        description: "最多返回结果数，建议不超过 20",
        default: 10,
        minimum: 1,
        maximum: 50
      }
    },
    required: ["query"],
    additionalProperties: false
  }
}
```

核心原则：
1. `description` 说清楚"什么时候用"和"什么时候不用"
2. 用 `enum` 替代自由文本，减少 LLM 猜测
3. 提供 `default` 值，减少必填参数数量
4. `additionalProperties: false` 防止 LLM 幻觉出不存在的参数
5. 工具数量控制在 20 个以内，过多会稀释 LLM 注意力
