# Skills / Agent 编排面试题图谱

> 覆盖 Agent 架构、工具调用、记忆系统、多 Agent 协作、异常处理、Skills 设计与可观测性七大核心模块。

---

## Q1. Agent 架构模式：ReAct vs Plan-and-Execute vs Reflexion

**难度：⭐⭐⭐** | **高频标签：** `#Agent架构` `#ReAct` `#规划` `#反思`

### 考察点

- 三种模式的工作流程与核心差异
- 各模式的适用场景与局限性
- 循环终止条件设计（防止无限循环）
- Thought-Action-Observation 循环的实现细节

### 参考答案

**ReAct（Reasoning + Acting）**

交替执行"思考"与"行动"，每一步都基于最新观察结果动态决策。流程：

```
Thought → Action → Observation → Thought → Action → ...→ Final Answer
```

优点：灵活、实时响应环境反馈；缺点：长任务中容易迷失方向，token 消耗大。

**Plan-and-Execute**

先由 Planner 生成完整计划（子任务列表），再由 Executor 逐步执行。流程：

```
Plan[t1, t2, t3] → Execute(t1) → Execute(t2) → Execute(t3) → Aggregate
```

优点：结构清晰、可并行执行子任务；缺点：计划生成后难以动态调整，对初始规划质量依赖高。

**Reflexion**

在 ReAct 基础上增加"反思"层：任务失败后，Agent 生成语言反思并存入记忆，下次尝试时参考。流程：

```
Attempt → Evaluate → Reflect(if failed) → Retry with memory
```

优点：自我改进能力强；缺点：需要额外的评估器，反思质量依赖模型能力。

**循环终止条件设计**

- 最大步数限制（硬上限）
- 检测重复 Action（相同工具+相同参数连续出现 N 次）
- 置信度阈值（模型输出 Final Answer 标记）
- 超时机制

### 代码示例：ReAct Agent 核心循环


```typescript
import OpenAI from "openai";

interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}

interface Step {
  thought: string;
  action?: { tool: string; input: string };
  observation?: string;
}

interface ReActConfig {
  maxSteps?: number;          // 最大步数，防止无限循环
  maxRepeatActions?: number;  // 相同 action 最大重复次数
}

async function runReActAgent(
  query: string,
  tools: Tool[],
  client: OpenAI,
  config: ReActConfig = {}
): Promise<string> {
  const { maxSteps = 10, maxRepeatActions = 3 } = config;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const steps: Step[] = [];
  // 用于检测重复 action：key = "toolName:input"
  const actionCount = new Map<string, number>();

  const systemPrompt = `You are a helpful assistant. Use tools to answer questions.
Available tools:
${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

Format:
Thought: <reasoning>
Action: <tool_name>
Action Input: <input>

When done:
Thought: I now know the final answer
Final Answer: <answer>`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0,
    });

    const text = response.choices[0].message.content ?? "";
    messages.push({ role: "assistant", content: text });

    // 解析 Final Answer
    const finalMatch = text.match(/Final Answer:\s*(.+)/s);
    if (finalMatch) {
      return finalMatch[1].trim();
    }

    // 解析 Action
    const actionMatch = text.match(/Action:\s*(\w+)\nAction Input:\s*(.+)/s);
    const thoughtMatch = text.match(/Thought:\s*(.+?)(?=\nAction:|$)/s);

    if (!actionMatch) {
      // 没有 action 也没有 final answer，视为异常终止
      throw new Error(`Step ${step}: Unexpected output format:\n${text}`);
    }

    const [, toolName, toolInput] = actionMatch;
    const thought = thoughtMatch?.[1]?.trim() ?? "";

    // 检测重复 action（防止死循环）
    const actionKey = `${toolName}:${toolInput.trim()}`;
    const count = (actionCount.get(actionKey) ?? 0) + 1;
    actionCount.set(actionKey, count);
    if (count >= maxRepeatActions) {
      throw new Error(`Detected repeated action "${actionKey}" (${count} times). Aborting.`);
    }

    // 执行工具
    const tool = toolMap.get(toolName);
    let observation: string;
    if (!tool) {
      observation = `Error: Tool "${toolName}" not found. Available: ${[...toolMap.keys()].join(", ")}`;
    } else {
      try {
        observation = await tool.execute(toolInput.trim());
      } catch (err) {
        observation = `Error executing ${toolName}: ${(err as Error).message}`;
      }
    }

    steps.push({ thought, action: { tool: toolName, input: toolInput }, observation });
    messages.push({ role: "user", content: `Observation: ${observation}` });
  }

  throw new Error(`Exceeded max steps (${maxSteps}) without reaching a final answer.`);
}
```

### 延伸思考

- Reflexion 的反思记忆应存储多少条？过多会污染上下文，过少则学不到教训。
- Plan-and-Execute 中，如果某个子任务失败，是否需要重新规划？如何设计回滚机制？
- ReAct 在多轮对话场景下，如何压缩历史 steps 以节省 token？

---

## Q2. 工具选择与调用链规划

**难度：⭐⭐⭐** | **高频标签：** `#ToolCalling` `#并行调用` `#上下文管理`

### 考察点

- LLM 如何决策调用哪个工具（工具描述质量的影响）
- 并行工具调用 vs 串行工具调用的选择依据
- 工具调用结果的注入与上下文窗口管理
- OpenAI Function Calling / Tool Use 协议细节

### 参考答案

**工具描述的重要性**

LLM 通过工具的 `name`、`description`、`parameters` schema 来决策是否调用及如何调用。描述质量直接影响调用准确率：

- 描述应包含：工具的功能、适用场景、输入输出格式、限制条件
- 避免歧义：两个功能相近的工具需要明确区分使用场景
- 参数 schema 要精确：使用 `enum`、`pattern`、`minimum/maximum` 约束输入

**并行 vs 串行**

- 并行：多个工具调用之间无数据依赖，可同时发起（如同时查天气和查日历）
- 串行：后一个工具的输入依赖前一个工具的输出（如先搜索再摘要）
- OpenAI API 支持在单次响应中返回多个 `tool_calls`，客户端并行执行后统一回传

**上下文管理**

工具结果通过 `tool` role 消息注入，需注意：
- 大型工具返回值（如网页内容）需截断或摘要后再注入
- 多轮工具调用后，历史 tool messages 可压缩为摘要

### 代码示例：支持并行工具调用的 Agent 执行器


```typescript
import OpenAI from "openai";

type ToolFunction = (args: Record<string, unknown>) => Promise<unknown>;

interface ToolDefinition {
  schema: OpenAI.ChatCompletionTool;
  execute: ToolFunction;
}

// 工具结果注入时的最大字符数（防止撑爆上下文）
const MAX_TOOL_RESULT_LENGTH = 4000;

function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  return result.slice(0, MAX_TOOL_RESULT_LENGTH) + "\n...[truncated]";
}

async function runParallelToolAgent(
  userMessage: string,
  tools: ToolDefinition[],
  client: OpenAI,
  maxRounds = 5
): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < maxRounds; round++) {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: tools.map((t) => t.schema),
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    messages.push(choice.message); // 保留 assistant 消息（含 tool_calls）

    // 没有工具调用，直接返回文本答案
    if (!choice.message.tool_calls?.length) {
      return choice.message.content ?? "";
    }

    // 并行执行所有工具调用
    const toolResults = await Promise.allSettled(
      choice.message.tool_calls.map(async (tc) => {
        const toolDef = tools.find(
          (t) => t.schema.function.name === tc.function.name
        );

        if (!toolDef) {
          return {
            tool_call_id: tc.id,
            content: `Error: Tool "${tc.function.name}" not registered.`,
          };
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          return {
            tool_call_id: tc.id,
            content: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
          };
        }

        try {
          const result = await toolDef.execute(args);
          const content = truncateResult(
            typeof result === "string" ? result : JSON.stringify(result, null, 2)
          );
          return { tool_call_id: tc.id, content };
        } catch (err) {
          // 工具执行失败时返回错误信息而非抛出，让 LLM 决策如何处理
          return {
            tool_call_id: tc.id,
            content: `Error: ${(err as Error).message}`,
          };
        }
      })
    );

    // 将所有工具结果注入消息列表
    for (const result of toolResults) {
      const value = result.status === "fulfilled"
        ? result.value
        : { tool_call_id: "unknown", content: "Unexpected execution error" };

      messages.push({
        role: "tool",
        tool_call_id: value.tool_call_id,
        content: value.content,
      });
    }
  }

  throw new Error(`Exceeded max rounds (${maxRounds}) in tool agent.`);
}
```

### 延伸思考

- 工具描述应该有多详细？过长的描述会占用 system prompt token，如何权衡？
- 当 LLM 生成了错误的工具参数（类型不匹配），是在客户端校验并返回错误，还是直接执行让工具报错？
- 如何设计工具的版本管理，使旧版 Agent 不受新版工具 schema 变更影响？

---

## Q3. Agent 的记忆系统设计

**难度：⭐⭐⭐** | **高频标签：** `#Memory` `#向量数据库` `#RAG` `#记忆压缩`

### 考察点

- 四种记忆类型的定义与实现方式
- 长期记忆的存储与检索（向量相似度搜索）
- 记忆压缩策略（滑动窗口、摘要压缩、重要性过滤）
- 记忆遗忘机制（TTL、访问频率衰减）

### 参考答案

**四种记忆类型**

| 类型 | 类比 | 实现方式 | 生命周期 |
|------|------|----------|----------|
| 工作记忆（Working） | 短期记忆 | 当前对话的 messages 数组 | 单次会话 |
| 情节记忆（Episodic） | 经历记忆 | 历史对话摘要，向量存储 | 跨会话持久化 |
| 语义记忆（Semantic） | 知识记忆 | 知识库、文档，向量检索 | 长期稳定 |
| 程序记忆（Procedural） | 技能记忆 | System prompt、Few-shot 示例 | 随模型/配置更新 |

**记忆压缩策略**

- 滑动窗口：保留最近 N 条消息，丢弃更早的
- 摘要压缩：用 LLM 将旧消息压缩为摘要，替换原始消息
- 重要性过滤：为每条记忆打分（基于访问频率、时间衰减、显式标记），低分记忆优先淘汰

**遗忘机制**

借鉴 Ebbinghaus 遗忘曲线：`importance = base_score * e^(-decay_rate * time_elapsed)`，定期清理低于阈值的记忆。

### 代码示例：带长期记忆的对话 Agent


```typescript
import OpenAI from "openai";

// 简化的向量存储接口（实际可替换为 Pinecone / Qdrant / pgvector）
interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  createdAt: number;
  accessCount: number;
  importance: number; // 0-1
}

interface VectorStore {
  upsert(entry: MemoryEntry): Promise<void>;
  search(embedding: number[], topK: number): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
  list(): Promise<MemoryEntry[]>;
}

class MemoryAgent {
  private workingMemory: OpenAI.ChatCompletionMessageParam[] = [];
  private readonly maxWorkingMemoryTokens = 3000; // 约 2400 tokens
  private readonly decayRate = 0.1; // 遗忘衰减率

  constructor(
    private client: OpenAI,
    private vectorStore: VectorStore,
    private systemPrompt: string
  ) {}

  // 生成文本的 embedding
  private async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return res.data[0].embedding;
  }

  // 余弦相似度（向量检索的核心）
  private cosineSimilarity(a: number[], b: number[]): number {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    return normA && normB ? dot / (normA * normB) : 0;
  }

  // 从长期记忆中检索相关内容
  private async retrieveRelevantMemories(query: string, topK = 3): Promise<string[]> {
    const queryEmbedding = await this.embed(query);
    const results = await this.vectorStore.search(queryEmbedding, topK);

    // 更新访问计数（影响重要性评分）
    for (const entry of results) {
      entry.accessCount += 1;
      entry.importance = Math.min(1, entry.importance + 0.05);
      await this.vectorStore.upsert(entry);
    }

    return results.map((r) => r.content);
  }

  // 将当前对话摘要存入长期记忆
  private async consolidateToLongTermMemory(): Promise<void> {
    if (this.workingMemory.length < 4) return; // 太短不值得压缩

    const summaryResponse = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Summarize the following conversation in 2-3 sentences, preserving key facts and decisions.",
        },
        ...this.workingMemory,
      ],
    });

    const summary = summaryResponse.choices[0].message.content ?? "";
    const embedding = await this.embed(summary);

    await this.vectorStore.upsert({
      id: `memory-${Date.now()}`,
      content: summary,
      embedding,
      createdAt: Date.now(),
      accessCount: 0,
      importance: 0.5,
    });

    // 压缩工作记忆：保留最近 2 条，其余替换为摘要
    const recent = this.workingMemory.slice(-2);
    this.workingMemory = [
      { role: "system", content: `[Memory Summary]: ${summary}` },
      ...recent,
    ];
  }

  // 定期清理低重要性记忆（遗忘机制）
  async pruneMemories(): Promise<void> {
    const now = Date.now();
    const entries = await this.vectorStore.list();

    for (const entry of entries) {
      const ageInDays = (now - entry.createdAt) / (1000 * 60 * 60 * 24);
      // 基于时间衰减的重要性
      const decayedImportance = entry.importance * Math.exp(-this.decayRate * ageInDays);

      if (decayedImportance < 0.1 && entry.accessCount === 0) {
        await this.vectorStore.delete(entry.id);
      }
    }
  }

  async chat(userMessage: string): Promise<string> {
    // 1. 从长期记忆检索相关内容
    const relevantMemories = await this.retrieveRelevantMemories(userMessage);

    // 2. 构建带记忆上下文的 system prompt
    const contextualSystem = relevantMemories.length > 0
      ? `${this.systemPrompt}\n\nRelevant memories:\n${relevantMemories.map((m) => `- ${m}`).join("\n")}`
      : this.systemPrompt;

    // 3. 添加用户消息到工作记忆
    this.workingMemory.push({ role: "user", content: userMessage });

    // 4. 调用 LLM
    const response = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: contextualSystem },
        ...this.workingMemory,
      ],
    });

    const assistantMessage = response.choices[0].message.content ?? "";
    this.workingMemory.push({ role: "assistant", content: assistantMessage });

    // 5. 工作记忆过长时压缩
    const estimatedTokens = JSON.stringify(this.workingMemory).length / 4;
    if (estimatedTokens > this.maxWorkingMemoryTokens) {
      await this.consolidateToLongTermMemory();
    }

    return assistantMessage;
  }
}
```

### 延伸思考

- 情节记忆的粒度如何选择？按对话轮次、按话题、还是按时间窗口切分？
- 向量检索的 topK 如何动态调整？查询越复杂是否应该检索更多记忆？
- 多用户场景下，如何隔离不同用户的记忆空间？

---

## Q4. 多 Agent 协作与编排

**难度：⭐⭐⭐** | **高频标签：** `#MultiAgent` `#Orchestrator` `#任务分解`

### 考察点

- 中心化编排（Orchestrator-Worker）vs 去中心化（Peer-to-Peer）的权衡
- Agent 间通信协议设计（消息格式、路由、确认机制）
- 任务分解策略与结果聚合
- 死锁检测与循环依赖处理

### 参考答案

**中心化 vs 去中心化**

| 维度 | Orchestrator-Worker | Peer-to-Peer |
|------|---------------------|--------------|
| 协调复杂度 | 低（单点决策） | 高（需共识协议） |
| 单点故障 | 有（Orchestrator 挂掉全停） | 无 |
| 可扩展性 | 受 Orchestrator 瓶颈限制 | 水平扩展好 |
| 适用场景 | 任务明确、层级清晰 | 动态协作、去中心化决策 |

**Agent 间通信协议**

消息应包含：`sender`、`receiver`（或 broadcast）、`type`（task/result/error/heartbeat）、`payload`、`correlationId`（追踪请求-响应对）、`timestamp`。

**任务分解**

Orchestrator 将复杂任务分解为 DAG（有向无环图），按依赖关系调度 Worker。需检测循环依赖（拓扑排序）。

### 代码示例：Orchestrator-Worker 多 Agent 系统


```typescript
import OpenAI from "openai";

// Agent 间通信消息格式
interface AgentMessage {
  id: string;
  correlationId?: string; // 关联请求 ID
  sender: string;
  receiver: string;
  type: "task" | "result" | "error" | "status";
  payload: unknown;
  timestamp: number;
}

// 子任务定义（DAG 节点）
interface SubTask {
  id: string;
  description: string;
  assignedAgent: string;
  dependencies: string[]; // 依赖的其他子任务 ID
  status: "pending" | "running" | "done" | "failed";
  result?: string;
}

class WorkerAgent {
  constructor(
    public readonly name: string,
    public readonly capability: string,
    private client: OpenAI
  ) {}

  async execute(task: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `You are a specialized agent for: ${this.capability}` },
        { role: "user", content: task },
      ],
    });
    return response.choices[0].message.content ?? "";
  }
}

class OrchestratorAgent {
  private workers = new Map<string, WorkerAgent>();

  constructor(private client: OpenAI) {}

  registerWorker(worker: WorkerAgent): void {
    this.workers.set(worker.name, worker);
  }

  // 拓扑排序检测循环依赖
  private topologicalSort(tasks: SubTask[]): SubTask[] | null {
    const inDegree = new Map(tasks.map((t) => [t.id, t.dependencies.length]));
    const queue = tasks.filter((t) => t.dependencies.length === 0);
    const sorted: SubTask[] = [];

    while (queue.length > 0) {
      const task = queue.shift()!;
      sorted.push(task);

      for (const other of tasks) {
        if (other.dependencies.includes(task.id)) {
          const deg = (inDegree.get(other.id) ?? 0) - 1;
          inDegree.set(other.id, deg);
          if (deg === 0) queue.push(other);
        }
      }
    }

    // 如果排序后数量不等，说明存在循环依赖
    return sorted.length === tasks.length ? sorted : null;
  }

  // 将复杂任务分解为子任务列表
  private async decompose(goal: string): Promise<SubTask[]> {
    const workerList = [...this.workers.values()]
      .map((w) => `- ${w.name}: ${w.capability}`)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a task orchestrator. Decompose the goal into subtasks.
Available workers:\n${workerList}

Respond with JSON array:
[{"id":"t1","description":"...","assignedAgent":"worker_name","dependencies":[]}]`,
        },
        { role: "user", content: `Goal: ${goal}` },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    const rawTasks: Omit<SubTask, "status">[] = parsed.tasks ?? [];
    return rawTasks.map((t) => ({ ...t, status: "pending" as const }));
  }

  async run(goal: string): Promise<string> {
    // 1. 分解任务
    const tasks = await this.decompose(goal);

    // 2. 检测循环依赖
    const sorted = this.topologicalSort(tasks);
    if (!sorted) {
      throw new Error("Circular dependency detected in task graph.");
    }

    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    // 3. 按拓扑顺序执行（满足依赖的任务可并行）
    const executed = new Set<string>();

    while (executed.size < sorted.length) {
      // 找出所有依赖已满足且未执行的任务
      const ready = sorted.filter(
        (t) =>
          !executed.has(t.id) &&
          t.dependencies.every((dep) => {
            const depTask = taskMap.get(dep);
            return depTask?.status === "done";
          })
      );

      if (ready.length === 0) {
        throw new Error("No tasks ready to execute — possible deadlock.");
      }

      // 并行执行所有就绪任务
      await Promise.all(
        ready.map(async (task) => {
          const worker = this.workers.get(task.assignedAgent);
          if (!worker) {
            task.status = "failed";
            task.result = `Worker "${task.assignedAgent}" not found.`;
            executed.add(task.id);
            return;
          }

          task.status = "running";

          // 将依赖任务的结果注入当前任务描述
          const depContext = task.dependencies
            .map((dep) => {
              const depTask = taskMap.get(dep);
              return depTask?.result ? `[${dep} result]: ${depTask.result}` : "";
            })
            .filter(Boolean)
            .join("\n");

          const fullDescription = depContext
            ? `${task.description}\n\nContext from previous steps:\n${depContext}`
            : task.description;

          try {
            task.result = await worker.execute(fullDescription);
            task.status = "done";
          } catch (err) {
            task.status = "failed";
            task.result = `Error: ${(err as Error).message}`;
          }

          executed.add(task.id);
        })
      );
    }

    // 4. 聚合所有结果
    const allResults = sorted
      .map((t) => `[${t.id}] ${t.description}:\n${t.result}`)
      .join("\n\n");

    const aggregation = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Synthesize the following subtask results into a coherent final answer." },
        { role: "user", content: `Goal: ${goal}\n\nResults:\n${allResults}` },
      ],
    });

    return aggregation.choices[0].message.content ?? "";
  }
}
```

### 延伸思考

- 当某个 Worker 失败时，Orchestrator 是否应该重新规划剩余任务？
- 如何为 Worker Agent 设计能力声明（Capability Declaration），使 Orchestrator 能动态发现和选择 Worker？
- 多 Agent 系统中如何防止 Agent 之间的"责任推卸"（每个 Agent 都认为某任务是别人的职责）？

---

## Q5. Agent 的异常处理与自我修复

**难度：⭐⭐⭐** | **高频标签：** `#ErrorHandling` `#自愈` `#重试策略` `#降级`

### 考察点

- 工具调用失败的重试策略（指数退避、备用工具）
- 陷入循环的检测算法（状态哈希、步骤相似度）
- 任务失败时的优雅降级（部分结果返回）
- 自我修复的边界（何时应该放弃而非无限重试）

### 参考答案

**重试策略层次**

1. 立即重试（网络抖动）
2. 指数退避重试（服务限流）
3. 切换备用工具（主工具不可用）
4. 降低任务复杂度重试（简化输入）
5. 优雅降级（返回部分结果 + 错误说明）

**循环检测**

- 状态哈希：对 (action, input) 对计算哈希，检测完全重复
- 语义相似度：对连续步骤的 thought 计算相似度，检测语义循环
- 进度检测：如果连续 N 步没有新信息产生，判定为停滞

**自我修复触发条件**

- 工具返回错误 → 分析错误类型 → 选择修复策略
- 输出格式错误 → 提示 LLM 重新格式化
- 任务超出能力范围 → 主动声明失败并解释原因

### 代码示例：带自我修复能力的 Agent


```typescript
import OpenAI from "openai";

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface ToolError {
  toolName: string;
  error: string;
  attempt: number;
}

// 指数退避延迟
function exponentialBackoff(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  // 加入随机抖动，防止多个 Agent 同时重试造成雪崩
  const jitter = Math.random() * 0.3 * delay;
  return Math.min(delay + jitter, config.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SelfHealingAgent {
  // 步骤状态哈希，用于循环检测
  private stepHashes = new Set<string>();
  // 连续无进展步骤计数
  private stagnantSteps = 0;
  private readonly maxStagnantSteps = 3;

  // 错误历史，用于自我修复决策
  private errorHistory: ToolError[] = [];

  constructor(
    private client: OpenAI,
    private retryConfig: RetryConfig = {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 10000,
    }
  ) {}

  // 检测步骤是否重复（循环检测）
  private detectLoop(action: string, input: string): boolean {
    const hash = `${action}::${input}`;
    if (this.stepHashes.has(hash)) return true;
    this.stepHashes.add(hash);
    return false;
  }

  // 带重试的工具执行
  private async executeWithRetry(
    toolName: string,
    execute: () => Promise<string>,
    fallback?: () => Promise<string>
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await execute();
        // 成功后重置该工具的错误计数
        this.errorHistory = this.errorHistory.filter((e) => e.toolName !== toolName);
        return result;
      } catch (err) {
        lastError = err as Error;
        this.errorHistory.push({ toolName, error: lastError.message, attempt });

        // 判断错误类型决定是否重试
        const isRetryable = this.isRetryableError(lastError);
        if (!isRetryable || attempt === this.retryConfig.maxRetries) break;

        const delay = exponentialBackoff(attempt, this.retryConfig);
        console.warn(`[${toolName}] Attempt ${attempt + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }

    // 所有重试失败，尝试 fallback
    if (fallback) {
      console.warn(`[${toolName}] All retries failed. Trying fallback...`);
      try {
        return await fallback();
      } catch (fallbackErr) {
        return `[Fallback also failed] Original: ${lastError?.message}. Fallback: ${(fallbackErr as Error).message}`;
      }
    }

    return `[Tool Error] ${toolName}: ${lastError?.message ?? "Unknown error"}`;
  }

  // 判断错误是否可重试
  private isRetryableError(err: Error): boolean {
    const message = err.message.toLowerCase();
    // 速率限制、超时、网络错误可重试
    if (message.includes("rate limit") || message.includes("timeout") || message.includes("network")) {
      return true;
    }
    // 参数错误、权限错误不可重试
    if (message.includes("invalid") || message.includes("unauthorized") || message.includes("not found")) {
      return false;
    }
    return true; // 默认可重试
  }

  // 自我修复：分析错误历史，生成修复建议
  private async generateRepairStrategy(
    failedStep: string,
    errors: ToolError[]
  ): Promise<string> {
    const errorSummary = errors
      .map((e) => `- ${e.toolName} (attempt ${e.attempt}): ${e.error}`)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an agent debugger. Analyze the errors and suggest a repair strategy.",
        },
        {
          role: "user",
          content: `Failed step: ${failedStep}\n\nErrors encountered:\n${errorSummary}\n\nSuggest an alternative approach.`,
        },
      ],
    });

    return response.choices[0].message.content ?? "No repair strategy available.";
  }

  async runWithSelfHealing(
    task: string,
    tools: Map<string, { execute: (input: string) => Promise<string>; fallback?: () => Promise<string> }>
  ): Promise<{ result: string; repaired: boolean; partialResults: string[] }> {
    const partialResults: string[] = [];
    let repaired = false;
    let stagnantObservation = "";

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `Complete the task using available tools: ${[...tools.keys()].join(", ")}.
If a tool fails, try an alternative approach. Report partial progress if full completion is impossible.`,
      },
      { role: "user", content: task },
    ];

    for (let step = 0; step < 15; step++) {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o",
        messages,
        temperature: 0,
      });

      const text = response.choices[0].message.content ?? "";
      messages.push({ role: "assistant", content: text });

      // 检测最终答案
      const finalMatch = text.match(/Final Answer:\s*(.+)/s);
      if (finalMatch) {
        return { result: finalMatch[1].trim(), repaired, partialResults };
      }

      const actionMatch = text.match(/Action:\s*(\w+)\nAction Input:\s*(.+?)(?=\n|$)/s);
      if (!actionMatch) continue;

      const [, toolName, toolInput] = actionMatch;

      // 循环检测
      if (this.detectLoop(toolName, toolInput)) {
        console.warn(`Loop detected at step ${step}. Triggering self-repair...`);
        const repairStrategy = await this.generateRepairStrategy(
          `${toolName}(${toolInput})`,
          this.errorHistory
        );
        messages.push({
          role: "user",
          content: `Observation: [LOOP DETECTED] You've tried this exact action before. Repair strategy: ${repairStrategy}`,
        });
        repaired = true;
        continue;
      }

      // 停滞检测
      const toolDef = tools.get(toolName);
      let observation: string;

      if (!toolDef) {
        observation = `Error: Tool "${toolName}" not available.`;
      } else {
        observation = await this.executeWithRetry(
          toolName,
          () => toolDef.execute(toolInput),
          toolDef.fallback
        );
      }

      // 检测是否有实质进展
      if (observation === stagnantObservation) {
        this.stagnantSteps++;
        if (this.stagnantSteps >= this.maxStagnantSteps) {
          return {
            result: `Task partially completed. Stagnated after ${step} steps.`,
            repaired,
            partialResults,
          };
        }
      } else {
        this.stagnantSteps = 0;
        stagnantObservation = observation;
        partialResults.push(`Step ${step}: ${observation.slice(0, 100)}`);
      }

      messages.push({ role: "user", content: `Observation: ${observation}` });
    }

    // 超出步数限制，返回部分结果
    return {
      result: `Task incomplete after max steps. Partial results: ${partialResults.join("; ")}`,
      repaired,
      partialResults,
    };
  }
}
```

### 延伸思考

- 自我修复的"修复建议"本身也可能出错，如何避免修复过程引入新问题？
- 在生产环境中，Agent 的重试行为应该对用户透明吗？如何设计进度反馈？
- 如何区分"任务本身不可完成"和"当前工具集不足以完成任务"这两种失败？

---

## Q6. Skills 的定义、注册与动态加载

**难度：⭐⭐** | **高频标签：** `#Skills` `#插件系统` `#动态路由` `#元数据`

### 考察点

- Skill 与 Tool 的本质区别
- Skill 元数据设计（触发条件、前置/后置条件、能力声明）
- 动态 Skill 发现与热加载机制
- Skill 路由策略（基于意图匹配 vs 基于规则）

### 参考答案

**Skill vs Tool**

Tool 是原子操作（如"搜索网页"、"执行代码"），Skill 是更高层的能力抽象，可以组合多个 Tool 完成一类任务（如"研究某个话题"= 搜索 + 阅读 + 摘要）。

Skill 的特征：
- 有明确的触发意图（intent）
- 有前置条件（preconditions）：执行前需满足的状态
- 有后置条件（postconditions）：执行后保证的状态
- 可以有参数 schema
- 可以有优先级和互斥关系

**动态加载**

Skill 以插件形式存在，通过文件系统扫描或注册中心发现。热加载需要：
- 文件变更监听（fs.watch）
- 模块缓存清理（delete require.cache）
- 版本兼容性检查

### 代码示例：Skill 注册中心与动态路由


```typescript
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

// Skill 元数据定义
interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  // 触发意图关键词（用于路由匹配）
  intents: string[];
  // 前置条件：执行前必须满足的上下文条件
  preconditions: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
  // 后置条件：执行后保证提供的输出
  postconditions: string[];
  // 参数 schema（JSON Schema 格式）
  parametersSchema: Record<string, unknown>;
  // 优先级（数字越大越优先）
  priority: number;
  // 互斥的 Skill 名称（不能同时激活）
  mutuallyExclusive?: string[];
}

// Skill 执行接口
interface Skill {
  metadata: SkillMetadata;
  execute: (
    params: Record<string, unknown>,
    context: AgentContext
  ) => Promise<SkillResult>;
}

interface AgentContext {
  userId?: string;
  sessionId: string;
  memory: Record<string, unknown>;
  tools: Map<string, (input: string) => Promise<string>>;
}

interface SkillResult {
  success: boolean;
  output: string;
  // 执行后更新的上下文
  contextUpdates?: Record<string, unknown>;
  // 建议下一步调用的 Skill
  suggestedNextSkill?: string;
}

class SkillRegistry {
  private skills = new Map<string, Skill>();
  private watchers = new Map<string, fs.FSWatcher>();

  register(skill: Skill): void {
    const existing = this.skills.get(skill.metadata.name);
    if (existing) {
      // 版本比较，只允许升级
      if (!this.isNewerVersion(skill.metadata.version, existing.metadata.version)) {
        console.warn(
          `Skill "${skill.metadata.name}" v${skill.metadata.version} is not newer than existing v${existing.metadata.version}. Skipping.`
        );
        return;
      }
    }
    this.skills.set(skill.metadata.name, skill);
    console.log(`Registered skill: ${skill.metadata.name} v${skill.metadata.version}`);
  }

  unregister(name: string): void {
    this.skills.delete(name);
    const watcher = this.watchers.get(name);
    if (watcher) {
      watcher.close();
      this.watchers.delete(name);
    }
  }

  // 从目录动态加载 Skill 插件
  async loadFromDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      throw new Error(`Skill directory not found: ${dir}`);
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".skill.js"));

    for (const file of files) {
      await this.loadSkillFile(path.join(dir, file));
    }

    // 监听目录变更（热加载）
    fs.watch(dir, async (event, filename) => {
      if (filename?.endsWith(".skill.js")) {
        const filePath = path.join(dir, filename);
        if (event === "change" && fs.existsSync(filePath)) {
          console.log(`Hot-reloading skill: ${filename}`);
          // 清除模块缓存
          delete require.cache[require.resolve(filePath)];
          await this.loadSkillFile(filePath);
        } else if (event === "rename" && !fs.existsSync(filePath)) {
          // 文件被删除，注销对应 Skill
          const skillName = filename.replace(".skill.js", "");
          this.unregister(skillName);
        }
      }
    });
  }

  private async loadSkillFile(filePath: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(filePath);
      const skill: Skill = module.default ?? module;

      if (!skill?.metadata?.name) {
        console.error(`Invalid skill file: ${filePath} (missing metadata.name)`);
        return;
      }

      this.register(skill);
    } catch (err) {
      console.error(`Failed to load skill from ${filePath}:`, (err as Error).message);
    }
  }

  private isNewerVersion(newVer: string, oldVer: string): boolean {
    const parse = (v: string) => v.split(".").map(Number);
    const [nMaj, nMin, nPatch] = parse(newVer);
    const [oMaj, oMin, oPatch] = parse(oldVer);
    if (nMaj !== oMaj) return nMaj > oMaj;
    if (nMin !== oMin) return nMin > oMin;
    return nPatch > oPatch;
  }

  getAll(): Skill[] {
    return [...this.skills.values()];
  }
}

// 基于 LLM 的 Skill 路由器
class SkillRouter {
  constructor(
    private registry: SkillRegistry,
    private client: OpenAI
  ) {}

  // 根据用户意图选择最合适的 Skill
  async route(
    userIntent: string,
    context: AgentContext
  ): Promise<{ skill: Skill; params: Record<string, unknown> } | null> {
    const skills = this.registry.getAll();
    if (skills.length === 0) return null;

    // 检查前置条件，过滤不满足条件的 Skill
    const eligibleSkills = skills.filter((skill) => {
      return skill.metadata.preconditions
        .filter((p) => p.required)
        .every((p) => context.memory[p.key] !== undefined);
    });

    if (eligibleSkills.length === 0) return null;

    // 按优先级排序
    eligibleSkills.sort((a, b) => b.metadata.priority - a.metadata.priority);

    const skillDescriptions = eligibleSkills
      .map(
        (s) =>
          `- ${s.metadata.name} (v${s.metadata.version}): ${s.metadata.description}\n  Intents: ${s.metadata.intents.join(", ")}`
      )
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Select the most appropriate skill for the user's intent and extract parameters.
Available skills:\n${skillDescriptions}

Respond with JSON: {"skillName": "...", "params": {...}, "confidence": 0.0-1.0}
If no skill matches, respond: {"skillName": null, "params": {}, "confidence": 0}`,
        },
        { role: "user", content: userIntent },
      ],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content ?? "{}");

    if (!result.skillName || result.confidence < 0.6) return null;

    const selectedSkill = eligibleSkills.find((s) => s.metadata.name === result.skillName);
    if (!selectedSkill) return null;

    // 检查互斥约束
    if (selectedSkill.metadata.mutuallyExclusive) {
      const activeSkills = (context.memory.activeSkills as string[]) ?? [];
      const conflict = selectedSkill.metadata.mutuallyExclusive.find((name) =>
        activeSkills.includes(name)
      );
      if (conflict) {
        console.warn(`Skill "${selectedSkill.metadata.name}" conflicts with active skill "${conflict}".`);
        return null;
      }
    }

    return { skill: selectedSkill, params: result.params ?? {} };
  }
}
```

### 延伸思考

- Skill 的版本管理如何处理破坏性变更（breaking changes）？是否需要适配层？
- 当多个 Skill 都匹配用户意图时，除了优先级，还有哪些维度可以用于决策？
- Skill 的前置条件检查应该在路由层还是执行层？各有什么优缺点？

---

## Q7. Agent 的可观测性与调试

**难度：⭐⭐** | **高频标签：** `#Observability` `#OpenTelemetry` `#Tracing` `#调试`

### 考察点

- Trace 链路追踪的核心概念（Span、Trace、Context Propagation）
- LangSmith / Langfuse 的实现原理
- Agent 执行步骤的结构化日志设计
- 回放与调试工具的设计思路

### 参考答案

**核心概念**

- Trace：一次完整的 Agent 执行过程，由多个 Span 组成
- Span：单个操作单元（如一次 LLM 调用、一次工具执行），包含开始时间、结束时间、属性、事件
- Context Propagation：跨异步操作传递 Trace 上下文（TraceId、SpanId）

**LangSmith / Langfuse 原理**

本质是在 LLM 调用和工具调用的前后插入钩子（Hook），收集：
- 输入/输出内容
- Token 用量
- 延迟
- 错误信息
- 自定义元数据

数据通过异步批量上报到后端，不阻塞主流程。

**结构化日志设计**

每个 Agent 步骤应记录：
- `traceId`、`spanId`、`parentSpanId`
- `agentName`、`stepType`（llm_call / tool_call / decision）
- `input`、`output`（可截断）
- `durationMs`、`tokenUsage`
- `error`（如有）

### 代码示例：带 OpenTelemetry 追踪的 Agent 执行器


```typescript
import OpenAI from "openai";
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
  Tracer,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

// 初始化 OpenTelemetry（通常在应用启动时执行一次）
function initTracing(serviceName: string): Tracer {
  const provider = new NodeTracerProvider();

  // 导出到 Langfuse / Jaeger / OTLP 兼容后端
  const exporter = new OTLPTraceExporter({
    url: process.env.OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
    headers: {
      Authorization: `Bearer ${process.env.LANGFUSE_API_KEY ?? ""}`,
    },
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();

  return trace.getTracer(serviceName, "1.0.0");
}

// 结构化日志条目
interface AgentLogEntry {
  traceId: string;
  spanId: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  stepType: "llm_call" | "tool_call" | "decision" | "memory_read" | "memory_write";
  agentName: string;
  input?: string;
  output?: string;
  durationMs?: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
  error?: string;
  metadata?: Record<string, unknown>;
}

class ObservableAgentExecutor {
  private tracer: Tracer;
  private logs: AgentLogEntry[] = [];

  constructor(
    private agentName: string,
    private client: OpenAI,
    tracerServiceName = "agent-service"
  ) {
    this.tracer = initTracing(tracerServiceName);
  }

  // 记录结构化日志
  private log(entry: Omit<AgentLogEntry, "timestamp">): void {
    const fullEntry: AgentLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(fullEntry);

    // 同时输出到 stdout（结构化 JSON，便于日志聚合系统解析）
    console.log(JSON.stringify(fullEntry));
  }

  // 带追踪的 LLM 调用
  private async tracedLLMCall(
    messages: OpenAI.ChatCompletionMessageParam[],
    parentSpanContext?: ReturnType<typeof context.active>
  ): Promise<OpenAI.ChatCompletion> {
    return this.tracer.startActiveSpan(
      "llm.chat_completion",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.model": "gpt-4o",
          "llm.message_count": messages.length,
          "agent.name": this.agentName,
        },
      },
      parentSpanContext ?? context.active(),
      async (span) => {
        const startTime = Date.now();
        const traceId = span.spanContext().traceId;
        const spanId = span.spanContext().spanId;

        try {
          const response = await this.client.chat.completions.create({
            model: "gpt-4o",
            messages,
          });

          const usage = response.usage;
          const durationMs = Date.now() - startTime;

          // 记录 token 用量到 Span 属性
          if (usage) {
            span.setAttributes({
              "llm.token.prompt": usage.prompt_tokens,
              "llm.token.completion": usage.completion_tokens,
              "llm.token.total": usage.total_tokens,
            });
          }

          span.setStatus({ code: SpanStatusCode.OK });

          this.log({
            traceId,
            spanId,
            level: "info",
            stepType: "llm_call",
            agentName: this.agentName,
            input: messages[messages.length - 1].content as string,
            output: response.choices[0].message.content?.slice(0, 500),
            durationMs,
            tokenUsage: usage
              ? {
                  prompt: usage.prompt_tokens,
                  completion: usage.completion_tokens,
                  total: usage.total_tokens,
                }
              : undefined,
          });

          return response;
        } catch (err) {
          const error = err as Error;
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          span.recordException(error);

          this.log({
            traceId,
            spanId,
            level: "error",
            stepType: "llm_call",
            agentName: this.agentName,
            durationMs: Date.now() - startTime,
            error: error.message,
          });

          throw err;
        } finally {
          span.end();
        }
      }
    );
  }

  // 带追踪的工具调用
  private async tracedToolCall(
    toolName: string,
    toolInput: string,
    execute: () => Promise<string>
  ): Promise<string> {
    return this.tracer.startActiveSpan(
      `tool.${toolName}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "tool.name": toolName,
          "tool.input": toolInput.slice(0, 200),
          "agent.name": this.agentName,
        },
      },
      async (span) => {
        const startTime = Date.now();
        const traceId = span.spanContext().traceId;
        const spanId = span.spanContext().spanId;

        try {
          const result = await execute();
          const durationMs = Date.now() - startTime;

          span.setAttribute("tool.output_length", result.length);
          span.setStatus({ code: SpanStatusCode.OK });

          this.log({
            traceId,
            spanId,
            level: "info",
            stepType: "tool_call",
            agentName: this.agentName,
            input: toolInput,
            output: result.slice(0, 300),
            durationMs,
            metadata: { toolName },
          });

          return result;
        } catch (err) {
          const error = err as Error;
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          span.recordException(error);

          this.log({
            traceId,
            spanId,
            level: "error",
            stepType: "tool_call",
            agentName: this.agentName,
            input: toolInput,
            error: error.message,
            metadata: { toolName },
          });

          throw err;
        } finally {
          span.end();
        }
      }
    );
  }

  // 获取执行日志（用于调试回放）
  getExecutionLogs(): AgentLogEntry[] {
    return [...this.logs];
  }

  // 生成执行摘要（便于调试）
  generateExecutionSummary(): string {
    const totalDuration = this.logs.reduce((sum, l) => sum + (l.durationMs ?? 0), 0);
    const totalTokens = this.logs.reduce(
      (sum, l) => sum + (l.tokenUsage?.total ?? 0),
      0
    );
    const errors = this.logs.filter((l) => l.level === "error");
    const llmCalls = this.logs.filter((l) => l.stepType === "llm_call").length;
    const toolCalls = this.logs.filter((l) => l.stepType === "tool_call").length;

    return [
      `=== Agent Execution Summary ===`,
      `Agent: ${this.agentName}`,
      `Total Steps: ${this.logs.length} (${llmCalls} LLM calls, ${toolCalls} tool calls)`,
      `Total Duration: ${totalDuration}ms`,
      `Total Tokens: ${totalTokens}`,
      `Errors: ${errors.length}`,
      errors.length > 0
        ? `Error Details:\n${errors.map((e) => `  - [${e.stepType}] ${e.error}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
```

### 延伸思考

- Agent 的 Trace 数据可能包含敏感信息（用户输入、工具返回值），如何在可观测性和隐私保护之间取得平衡？
- 如何设计 Agent 执行的"回放"功能？需要记录哪些状态才能完整重现一次执行？
- 在高并发场景下，结构化日志的异步批量上报如何保证不丢失关键错误信息？

---

## 延伸阅读

1. [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) — ReAct 原始论文，Yao et al. 2022
2. [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) — Reflexion 架构论文
3. [LangGraph Documentation — Agent Architectures](https://langchain-ai.github.io/langgraph/concepts/agentic_concepts/) — LangGraph 官方文档，涵盖 ReAct、Plan-and-Execute 等模式的实现
4. [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling) — 工具调用协议官方文档
5. [Cognitive Architectures for Language Agents (CoALA)](https://arxiv.org/abs/2309.02427) — 系统性梳理 Agent 记忆、行动、决策的认知架构论文
6. [OpenTelemetry for LLM Observability](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — OpenTelemetry GenAI 语义约定，标准化 LLM 可观测性
7. [Langfuse Open Source LLM Engineering Platform](https://langfuse.com/docs) — Langfuse 架构文档，了解 Trace/Span 在 LLM 场景的实现细节
