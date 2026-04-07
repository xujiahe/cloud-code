# Claude Code 源码分析 — 面试指南

## 项目介绍

**项目**：Claude Code 源码深度解析（Anthropic AI 编程助手 CLI）

**一句话**：对生产级 AI Agent 系统进行系统性逆向分析，覆盖从启动到 API 流式处理的全链路架构，输出 21 份深度技术文档。

**核心工作**：

通过阅读约 35 个核心模块、200+ 源文件，梳理了一个生产级 AI Agent 系统的完整技术实现：

- SSE 流式解析：逐事件分析 6 种 SSE 事件类型，包括工具参数 JSON 分片拼接、thinking block 签名验证、非流式回退机制
- 工具调用系统：40+ 工具的统一接口设计、权限检查五层流程、并发安全控制
- 记忆与上下文：CLAUDE.md 多层级加载、Auto Memory 持久化、相关记忆语义召回、记忆提取后台 Agent
- 可靠性保障：结构化输出强制（SyntheticOutputTool + Stop Hook + Ajv）、重试策略（指数退避 + 529 降级 + 非流式回退）、tool_use/tool_result 配对修复
- 插件与 Skill 系统：Bundled Skill 的 Prompt 工程设计、fork 模式子 Agent、动态 Skill 发现

**技术栈**：TypeScript / Bun / React / 自定义 Ink TUI / Anthropic SDK / MCP / Zod / Yoga Layout

---

## 面试题目集

### 一、SSE 流式处理

**Q1：工具参数 JSON 分片如何处理？为什么不在每个 delta 到达时就解析？**

`content_block_start` 时将 `input` 初始化为空字符串 `''`，每个 `input_json_delta` 做字符串追加 `contentBlock.input += delta.partial_json`，直到 `content_block_stop` 时才调用 `JSON.parse`。

不提前解析的原因：每个 delta 只是 JSON 的一个片段，单独解析必然失败；字符串拼接是 O(1) 追加，等完整后一次解析是正确且高效的做法。

---

**Q2：`message_delta` 更新 `stop_reason` 时为什么用直接 mutation 而不是创建新对象？**

transcript 写入队列（100ms 懒写入）持有的是 `message.message` 的对象引用。如果用 `{ ...lastMsg.message, usage }` 创建新对象，队列里的引用指向旧对象，最终写入磁盘的 transcript 里 `stop_reason` 仍然是 null、`output_tokens` 仍然是 0。直接 mutation 确保队列里的引用和内存里的对象是同一个，写入时能拿到最终值。

---

**Q3：流式连接中途断开时，系统如何保证不产生"半截消息"？**

三层保障：

1. `streamWatchdog`（90 秒无数据自动中止）检测假死连接
2. 流式失败时触发非流式回退，对已 yield 的不完整消息发送 `tombstone` 信号，query.ts 收到后从 UI 和 transcript 中删除这些消息
3. 非流式请求一次性返回完整 `BetaMessage`，不存在分片问题

---

**Q4：`content_block_start` 时 `tool_use` 的 `input` 为什么必须初始化为 `''` 而不是 `{}`？**

如果初始化为 `{}`，后续 `input_json_delta` 做字符串追加时会变成 `"[object Object]{"file_path":...}"`，这是无效 JSON，`JSON.parse` 必然失败。初始化为空字符串 `''`，追加后得到完整 JSON 字符串，`content_block_stop` 时一次性解析成功。

---

**Q5：`thinking` block 的 `signature` 字段为什么在 `content_block_start` 时就初始化为 `''`？**

防御性初始化。如果流在 `signature_delta` 到达之前断开，`signature` 字段仍然存在（空字符串），不会导致后续访问 `undefined`。更重要的是，当流式回退发生时，不完整的 thinking block（有 thinking 内容但 signature 为空）会导致 API 拒绝，错误为 "thinking blocks cannot be modified"，这是触发 tombstone 清除机制的主要原因之一。

---

**Q6：为什么 `content_block_stop` 时每个 block 都立即 yield，而不是等整个消息完成后再 yield？**

实时渲染需要。一个 API 响应可能包含 text block + tool_use block，如果等整个消息完成才 yield，用户要等到工具参数全部流完才能看到文字内容。立即 yield 让 UI 可以：① 立即渲染文本（打字效果）；② 立即显示工具调用的"正在执行"状态。上层 query.ts 用最后一次 yield 的版本（包含所有 block）作为最终消息。

---

### 二、结构化输出与格式保证

**Q7：如何保证 SDK 调用方拿到的是符合 JSON Schema 的结构化输出？**

三层机制叠加：

1. `SyntheticOutputTool`：注入一个特殊工具，模型必须调用它来"返回"结果，工具内部用 Ajv 验证 schema，失败则抛出错误返回给模型重试
2. Stop Hook：每次 `end_turn` 时检查是否成功调用了 `StructuredOutput` 工具，没有则注入强制消息让模型再次调用
3. `sideQuery` 的 `output_format: json_schema`：API 层面强制，模型无法绕过

---

**Q8：`normalizeContentFromAPI` 中 JSON 解析失败时为什么降级为 `{}` 而不是抛出异常？**

降级为 `{}` 意味着工具收到空参数，触发 `validateInput()` 的 Zod 验证失败，返回错误给模型，模型看到错误后重新生成正确参数。这是"优雅降级 + 自动重试"的设计：不崩溃，但会多一轮 API 调用。如果直接抛出异常，整个会话会中断，用户体验更差。

---

**Q9：Bundled Skill（如 loop.ts）如何保证模型按照固定格式解析用户输入？**

Prompt 工程的精确设计：

- 用优先级顺序消除歧义（规则 1 > 规则 2 > 规则 3）
- 用精确正则定义匹配条件（`^\d+[smhd]$`）
- 用转换表格定义输出格式（interval → cron expression）
- 用反例防止误匹配（`check every PR` 不触发时间规则）

不依赖模型"猜测"，而是给出无歧义的解析规则。

---

### 三、工具系统与权限

**Q10：工具调用的权限检查有哪几层，顺序是什么？**

七层顺序检查：

1. `validateInput()`（工具特定输入验证，如路径合法性）
2. `alwaysDenyRules`（全局拒绝规则，立即拒绝）
3. `alwaysAllowRules`（全局允许规则，立即允许）
4. `tool.checkPermissions()`（工具特定权限逻辑）
5. PreToolUse hooks（用户自定义 hooks）
6. 自动分类器（auto 模式）
7. 用户交互确认（REPL 模式）

---

**Q11：`isConcurrencySafe` 这个标志有什么实际作用？**

决定工具是否可以并行执行。`query.ts` 中，当模型一次返回多个 `tool_use` block 时，`isConcurrencySafe = true` 的工具（如 `FileReadTool`、`GlobTool`）可以并发执行；`isConcurrencySafe = false` 的工具（如 `BashTool`、`FileEditTool`）必须串行执行。这是性能优化的关键：多个只读操作可以并行，写操作必须串行避免竞争。

---

**Q12：`ensureToolResultPairing` 解决什么问题，为什么需要它？**

修复 tool_use/tool_result 配对异常，有三种场景：

1. 流中断导致 tool_use 没有对应 tool_result（插入合成的错误 tool_result）
2. 会话恢复时历史被压缩，tool_result 没有对应的 tool_use（删除孤立的 tool_result）
3. orphan handler 多次运行导致跨消息重复 tool_use ID（跨消息去重）

API 对配对有严格要求，任何不匹配都会返回 400 错误导致会话卡死。

---

### 四、记忆与上下文

**Q13：CLAUDE.md 文件的加载优先级是什么？为什么越靠近 CWD 的文件优先级越高？**

优先级从低到高：Managed（企业策略）→ User（用户全局）→ Project（从根目录到 CWD 逐层）→ Local（CLAUDE.local.md）。

越靠近 CWD 的文件后加载，在系统提示中排在后面，模型对后面的内容注意力更高。这符合"局部覆盖全局"的直觉：项目特定规范应该覆盖用户全局偏好。

---

**Q14：相关记忆召回的工作原理是什么？为什么用 Sonnet 而不是向量搜索？**

工作原理：① `scanMemoryFiles` 读取所有记忆文件的 frontmatter（前 30 行），得到文件名 + 描述的清单；② 调用 Sonnet `sideQuery`，输入用户查询 + 记忆清单，输出最多 5 个相关文件名（JSON Schema 强制格式）；③ 读取选中文件内容作为附件注入。

用 Sonnet 而非向量搜索的原因：记忆文件数量少（上限 200 个），Sonnet 的语义理解比向量相似度更准确，且不需要维护向量索引基础设施。

---

**Q15：Auto Memory 的记忆提取是如何触发的，有什么防重入机制？**

每次对话轮次结束时（`handleStopHooks`）触发，条件：GrowthBook 开关 + 非远程模式 + 主 Agent + 本轮未直接写记忆。

防重入：`inProgress` 标志，如果正在提取则 stash 当前 context，等完成后运行一次"trailing extraction"（只处理两次调用之间新增的消息）。节流：`tengu_bramble_lintel` 控制每 N 轮才运行一次。

---

### 五、架构设计

**Q16：`getAutoMemPath()` 为什么用 canonical git root 而不是当前工作目录？**

保证同一个仓库的所有 git worktree 共享同一个记忆目录。如果用 CWD，在 `main` 分支工作时记忆存在 `projects/main/memory/`，切换到 worktree 后存在 `projects/feature-branch/memory/`，两个目录的记忆互相隔离，用户在一个 worktree 里学到的东西在另一个 worktree 里看不到。用 canonical git root 解决了这个问题。

---

**Q17：withRetry 的重试策略中，为什么后台查询不重试 529 错误？**

避免在服务器过载时放大请求量。前台查询（用户等待的）重试 529 是合理的，用户需要结果。后台查询（记忆提取、分类器等）失败对用户无感知，但如果也重试，在服务器过载时会产生大量额外请求，加剧过载（雪崩效应）。所以后台查询遇到 529 直接 `throw new CannotRetryError`，静默失败。

---

**Q18：Skill 的 `context: fork` 模式和默认 inline 模式有什么本质区别？**

inline 模式：Skill 内容展开为用户消息注入当前对话，模型在同一个 context window 内处理，共享 token 预算。

fork 模式：启动独立子 Agent（`runAgent`），有独立的 context window 和 token 预算，父 Agent 只看到子 Agent 的最终文本输出，不看中间步骤。fork 适合自包含的长任务（不需要用户中途干预），inline 适合需要用户实时反馈的任务。

---

## 关键数字速查

| 指标 | 数值 |
|------|------|
| 最大重试次数 | 10 次（DEFAULT_MAX_RETRIES） |
| 连续 529 触发降级 | 3 次（MAX_529_RETRIES） |
| 流式空闲超时 | 90 秒（STREAM_IDLE_TIMEOUT_MS） |
| 非流式回退超时 | 120s（远程）/ 300s（本地） |
| 记忆文件上限 | 200 个（MAX_MEMORY_FILES） |
| MEMORY.md 行数上限 | 200 行（MAX_ENTRYPOINT_LINES） |
| MEMORY.md 字节上限 | 25KB（MAX_ENTRYPOINT_BYTES） |
| 每轮相关记忆注入上限 | 5 个文件，每个 4KB |
| 会话累计记忆注入上限 | 60KB（MAX_SESSION_BYTES） |
| 记忆提取最大轮数 | 5 轮（maxTurns） |
| @include 最大递归深度 | 5 层（MAX_INCLUDE_DEPTH） |
| 指数退避基础延迟 | 500ms，上限 32s |
| 工具结果大小上限（默认） | 100,000 字符（maxResultSizeChars） |
| 数据迁移版本 | 11（CURRENT_MIGRATION_VERSION） |
