# 大模型返回数据解析与流式分片处理深度分析

## 概述

Claude Code 与 Anthropic API 的通信全程基于 **SSE（Server-Sent Events）流式传输**。从 API 返回的原始字节流，到最终渲染到终端，经历了多层解析、累积、规范化和分发。

---

## 一、SSE 流式事件类型（`services/api/claude.ts`）

API 返回的原始流是 `Stream<BetaRawMessageStreamEvent>`，包含以下事件类型：

```
message_start          → 消息开始，包含初始 usage 统计
  │
  ├── content_block_start[index]   → 新内容块开始（text/tool_use/thinking/...）
  │     ├── content_block_delta[index]  → 内容块增量（分片数据）
  │     │     ├── text_delta           → 文本增量
  │     │     ├── input_json_delta     → 工具调用参数增量（JSON 分片）
  │     │     ├── thinking_delta       → 思考内容增量
  │     │     └── signature_delta      → 签名增量（thinking 块）
  │     └── content_block_stop[index]  → 内容块结束 → 生成 AssistantMessage
  │
  ├── message_delta    → 消息级别更新（stop_reason, usage）
  └── message_stop     → 消息结束
```

### 核心累积逻辑

```typescript
// contentBlocks 数组按 index 累积每个块的内容
const contentBlocks: BetaContentBlock[] = []

// content_block_start：初始化块
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = { ...part.content_block, input: '' }
      // input 初始化为空字符串，后续 input_json_delta 追加
      break
    case 'text':
      contentBlocks[part.index] = { ...part.content_block, text: '' }
      break
    case 'thinking':
      contentBlocks[part.index] = { ...part.content_block, thinking: '', signature: '' }
      break
  }

// content_block_delta：追加增量
case 'content_block_delta':
  switch (delta.type) {
    case 'text_delta':
      contentBlock.text += delta.text          // 文本追加
      break
    case 'input_json_delta':
      contentBlock.input += delta.partial_json  // JSON 字符串追加（工具参数）
      break
    case 'thinking_delta':
      contentBlock.thinking += delta.thinking   // 思考内容追加
      break
  }

// content_block_stop：块完成，生成 AssistantMessage 并 yield
case 'content_block_stop':
  const m: AssistantMessage = {
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI([contentBlock], tools, agentId),
    },
    // ...
  }
  yield m  // 立即推送给上层消费者
```

### 关键细节：工具参数的 JSON 分片

工具调用参数（`input_json_delta`）是**字符串拼接**，不是 JSON 解析：

```typescript
// 每个 delta 只是 JSON 字符串的一个片段
contentBlock.input += delta.partial_json
// 例如：
// delta 1: '{"file'
// delta 2: '_path":'
// delta 3: ' "src/foo.ts"}'
// 最终：'{"file_path": "src/foo.ts"}'

// content_block_stop 时才解析 JSON
// normalizeContentFromAPI 中：
if (block.type === 'tool_use' && typeof block.input === 'string') {
  block.input = JSON.parse(block.input)  // 一次性解析完整 JSON
}
```

---

## 二、消息规范化（`utils/messages.ts`）

`normalizeContentFromAPI` 在每个 `content_block_stop` 时调用：

```typescript
function normalizeContentFromAPI(
  content: BetaContentBlock[],
  tools: Tools,
  agentId?: AgentId,
): ContentBlock[] {
  return content.map(block => {
    if (block.type === 'tool_use') {
      // 1. 解析 JSON 字符串为对象
      const input = typeof block.input === 'string'
        ? JSON.parse(block.input)
        : block.input

      // 2. 找到对应工具，调用 backfillObservableInput（添加派生字段）
      const tool = findToolByName(tools, block.name)
      const observableInput = { ...input }
      tool?.backfillObservableInput?.(observableInput)

      return { ...block, input: observableInput }
    }
    return block
  })
}
```

---

## 三、AssistantMessage 的流式 yield 时机

每个 `content_block_stop` 都会立即 yield 一个 `AssistantMessage`：

```typescript
// 同一个 message 可能被 yield 多次（每个 block 完成一次）
// 后续 block 的 AssistantMessage 包含前面所有已完成的 blocks

// 例如：一个包含 text + tool_use 的响应：
// yield 1（text block 完成）：{ content: [{ type: 'text', text: '...' }] }
// yield 2（tool_use block 完成）：{ content: [{ type: 'text', ... }, { type: 'tool_use', ... }] }
```

这意味着 UI 可以**实时渲染**文本，而不需要等待整个响应完成。

---

## 四、数据流向：从 API 到 UI

```
Anthropic API (SSE)
    │
    ▼
claude.ts::queryModel()
    │  for await (const part of stream)
    │  累积 contentBlocks[]
    │  content_block_stop → yield AssistantMessage
    │
    ▼
query.ts::queryLoop()
    │  for await (const message of deps.callModel(...))
    │  case 'assistant': yield* normalizeMessage(message)
    │  case 'tool_use': 执行工具 → 追加 tool_result
    │
    ▼
QueryEngine.ts::submitMessage()
    │  for await (const message of query(...))
    │  yield 给 SDK 消费者
    │
    ▼
[交互模式] REPL.tsx
    │  useLogMessages hook 监听消息
    │  → 追加到 messages 数组
    │  → React 重新渲染 Messages 组件
    │
    ▼
[无头模式] SDK 消费者
    for await (const msg of queryEngine.submitMessage(...))
```

---

## 五、工具调用的完整处理流程

```
API 返回 tool_use block
    │
    ▼
content_block_stop → yield AssistantMessage（含 tool_use）
    │
    ▼
query.ts 检测到 toolUseBlocks.length > 0
    │
    ├── StreamingToolExecutor（并行执行 concurrencySafe 工具）
    │   或
    └── runTools()（串行执行）
          │
          ├── canUseTool()  → 权限检查
          │     ├── validateInput()
          │     ├── alwaysDenyRules
          │     ├── alwaysAllowRules
          │     ├── tool.checkPermissions()
          │     └── 用户确认（REPL 模式）
          │
          ├── tool.call()   → 执行工具
          │     └── 返回 ToolResult<Output>
          │
          └── 构建 tool_result UserMessage
                └── 追加到 messages，继续下一轮 API 调用
```

---

## 六、命令系统深度解析

### 命令类型体系

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)

// PromptCommand：展开为 prompt 发给模型
// LocalCommand：本地执行，返回文本
// LocalJSXCommand：本地执行，渲染 Ink UI
```

### 命令加载流程（`commands.ts`）

```
getCommands(cwd)
    │
    ├── loadAllCommands(cwd)  [memoized by cwd]
    │     ├── getSkills(cwd)
    │     │     ├── getSkillDirCommands(cwd)    → 磁盘 Skill 文件
    │     │     ├── getPluginSkills()           → 插件 Skill
    │     │     ├── getBundledSkills()          → 内置 Skill（同步）
    │     │     └── getBuiltinPluginSkillCommands()
    │     │
    │     ├── getPluginCommands()               → 插件命令
    │     ├── getWorkflowCommands(cwd)          → 工作流命令
    │     └── COMMANDS()                        → 内置命令（memoized）
    │
    ├── getDynamicSkills()                      → 运行时发现的 Skill
    │
    └── 过滤：meetsAvailabilityRequirement() && isCommandEnabled()
```

### 斜杠命令处理（`processUserInput.ts`）

```
用户输入 "/review-pr 123"
    │
    ▼
processUserInput()
    │
    ├── 检测 ultraplan 关键词
    ├── 提取附件（@mentions, 图片等）
    │
    └── inputString.startsWith('/') → processSlashCommand()
          │
          ├── parseSlashCommand("/review-pr 123")
          │     → { commandName: "review-pr", args: "123" }
          │
          ├── findCommand("review-pr", commands)
          │
          ├── [LocalCommand] → command.load().then(m => m.call(args, ctx))
          │     → 返回 LocalCommandResult（文本/compact/skip）
          │
          ├── [LocalJSXCommand] → command.load().then(m => m.call(onDone, ctx, args))
          │     → 渲染 Ink UI 组件
          │
          └── [PromptCommand] → processPromptSlashCommand()
                │
                ├── command.getPromptForCommand(args, ctx)
                │     → 返回 ContentBlockParam[]（Skill 内容）
                │
                ├── 构建 UserMessage（含 Skill 内容）
                │
                └── 返回 { messages, shouldQuery: true, allowedTools, model }
```

### PromptCommand 的 getPromptForCommand

这是 Skill 的核心：将 Skill 内容注入为用户消息：

```typescript
// createSkillCommand 中的实现
async getPromptForCommand(args, toolUseContext) {
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  // 1. 参数替换（$ARGUMENTS, ${arg_name}）
  finalContent = substituteArguments(finalContent, args, true, argumentNames)

  // 2. 替换特殊变量
  finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

  // 3. 执行内联 shell 命令（!`command` 语法）
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(finalContent, ctx, ...)
  }

  return [{ type: 'text', text: finalContent }]
}
```

---

## 七、Skill 系统深度解析

### Skill 文件格式（SKILL.md）

```markdown
---
description: 审查 PR 并提供反馈
allowed-tools: [Read, Bash, WebFetch]
model: claude-opus-4-5
when_to_use: 当用户需要审查 PR 时使用
argument-hint: <PR number or URL>
user-invocable: true
context: fork  # 在子 Agent 中执行
effort: high
paths:
  - "src/**"   # 只在 src/ 下的文件被触碰时激活
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "echo 'Bash executed'"
---

# Review PR

Please review PR $ARGUMENTS and provide feedback on:
1. Code quality
2. Test coverage
3. Documentation

Base directory: ${CLAUDE_SKILL_DIR}
Session: ${CLAUDE_SESSION_ID}
```

### Skill 加载层级

```
getSkillDirCommands(cwd)
    │
    ├── 管理员 Skill（MDM 策略）
    │   ~/.claude/managed/.claude/skills/
    │
    ├── 用户 Skill
    │   ~/.claude/skills/<skill-name>/SKILL.md
    │
    ├── 项目 Skill（向上遍历到 home）
    │   <project>/.claude/skills/<skill-name>/SKILL.md
    │   <parent>/.claude/skills/<skill-name>/SKILL.md
    │
    ├── 额外目录（--add-dir）
    │   <dir>/.claude/skills/<skill-name>/SKILL.md
    │
    └── 遗留命令（/commands/ 目录）
        <project>/.claude/commands/<name>.md
        <project>/.claude/commands/<name>/SKILL.md
```

### 条件 Skill（paths 过滤）

```typescript
// 带 paths 的 Skill 只在模型触碰匹配文件后才激活
// 存储在 conditionalSkills Map 中

// 当 FileReadTool/FileEditTool 等工具访问文件时：
discoverSkillDirsForPaths(filePaths, cwd)
  // 从文件路径向上遍历，发现 .claude/skills/ 目录
  // 加载新发现的 Skill，检查 paths 是否匹配
  // 匹配则移入 unconditionalSkills，加入 dynamicSkills
```

### Skill 执行模式

```typescript
// 1. inline 模式（默认）：Skill 内容展开到当前对话
// SkillTool.call() → processPromptSlashCommand()
// → 返回 newMessages（含 Skill 内容）
// → contextModifier 更新 allowedTools 和 model

// 2. fork 模式：在子 Agent 中执行
// SkillTool.call() → executeForkedSkill()
// → runAgent() 启动独立子 Agent
// → 子 Agent 有独立 token budget 和消息历史
// → 返回子 Agent 的最终输出文本
```

### SkillTool 与命令系统的交互

```
模型决定调用 SkillTool({ skill: "review-pr", args: "123" })
    │
    ▼
SkillTool.validateInput()
    ├── 检查 skill 名称格式
    ├── getAllCommands(context) → 包含 MCP skills
    └── findCommand("review-pr", commands) → 验证存在

SkillTool.checkPermissions()
    ├── 检查 alwaysDenyRules
    ├── 检查 alwaysAllowRules
    ├── skillHasOnlySafeProperties() → 自动允许安全 Skill
    └── 否则 → 弹出权限确认对话框

SkillTool.call()
    ├── [fork] → executeForkedSkill() → runAgent()
    └── [inline] → processPromptSlashCommand()
          │
          ├── command.getPromptForCommand("123", ctx)
          │     → 返回 Skill 内容（含参数替换）
          │
          ├── 构建 UserMessage（<command-message> 标签包裹）
          │
          ├── addInvokedSkill()  → 记录已调用的 Skill
          ├── registerSkillHooks() → 注册 Skill 的 hooks
          │
          └── 返回 { messages, shouldQuery: true, allowedTools, model }
                │
                ▼
          SkillTool 返回 ToolResult
          newMessages = Skill 内容消息
          contextModifier = 更新 allowedTools + model
                │
                ▼
          query.ts 将 newMessages 追加到对话历史
          下一轮 API 调用时，模型看到 Skill 内容
```

---

## 八、插件系统深度解析

### 插件加载流程

```
initBuiltinPlugins()  [启动时]
    │
    └── 注册内置插件（如 claude-api skill）

loadAllPlugins()  [首次 getCommands 时]
    │
    ├── 扫描 ~/.claude/plugins/
    ├── 扫描 <project>/.claude/plugins/
    │
    └── 每个插件目录：
          ├── 读取 plugin.json（清单）
          ├── 验证版本兼容性
          ├── 加载 tools/（自定义工具）
          ├── 加载 commands/（自定义命令）
          ├── 加载 skills/（自定义 Skill）
          └── 注册 MCP 服务器配置
```

### 插件命令与 Skill 的区别

```typescript
// 插件命令（PromptCommand）
{
  source: 'plugin',
  loadedFrom: 'plugin',
  pluginInfo: { pluginManifest, repository },
  // 需要 hasUserSpecifiedDescription 才出现在 SkillTool 列表
}

// 插件 Skill（PromptCommand）
{
  source: 'plugin',
  loadedFrom: 'plugin',
  // 有 whenToUse 或 hasUserSpecifiedDescription
  // 出现在 getSlashCommandToolSkills() 返回列表
}
```

### 插件 MCP 服务器

```typescript
// 插件可以声明 MCP 服务器
// plugin.json:
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}

// 插件 MCP 工具被动态包装为 Tool 对象
// 工具名：mcp__<pluginName>__<toolName>
// 注册到 AppState.mcp.tools
```

---

## 九、内置 Skill（Bundled Skills）深度解析

以 `claude-api` Skill 为例：

```typescript
// skills/bundled/claudeApi.ts
registerBundledSkill({
  name: 'claude-api',
  description: 'Build apps with the Claude API...',
  allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],

  async getPromptForCommand(args) {
    // 1. 懒加载 247KB 的文档内容（避免启动时加载）
    const content = await import('./claudeApiContent.js')

    // 2. 检测项目语言（扫描文件扩展名）
    const lang = await detectLanguage()

    // 3. 根据语言选择相关文档片段
    const filePaths = getFilesForLanguage(lang, content)

    // 4. 构建提示词（含内联文档）
    const prompt = buildPrompt(lang, args, content)

    return [{ type: 'text', text: prompt }]
  },
})
```

### Bundled Skill 的文件提取机制

```typescript
// 带 files 字段的 Bundled Skill 会在首次调用时提取文件到磁盘
registerBundledSkill({
  name: 'my-skill',
  files: {
    'docs/guide.md': '# Guide\n...',
    'examples/basic.ts': 'const x = 1',
  },
  async getPromptForCommand(args) {
    // 首次调用时：
    // 1. extractBundledSkillFiles() 将 files 写入 ~/.claude/bundled-skills/<nonce>/my-skill/
    // 2. 使用 O_EXCL|O_NOFOLLOW 防止符号链接攻击
    // 3. 文件权限 0o600（仅所有者可读写）
    // 4. 提示词前缀添加 "Base directory for this skill: <dir>"
    // 模型可以用 Read/Grep 工具访问这些文件
  },
})
```

---

## 十、完整数据流总结

```
用户输入 "/claude-api build a chat app"
    │
    ▼
processUserInput() → processSlashCommand()
    │  findCommand("claude-api") → BundledSkill
    │  command.getPromptForCommand("build a chat app")
    │    → 懒加载文档 → 检测语言 → 构建提示词
    │  → UserMessage { content: "Base dir: ...\n\n# Claude API Skill\n..." }
    │
    ▼
query() → API 调用（含 Skill 内容作为用户消息）
    │
    ▼
API 返回 SSE 流
    │  message_start → 初始化
    │  content_block_start[0] { type: 'text' }
    │  content_block_delta[0] { text_delta: "I'll help..." }
    │  content_block_delta[0] { text_delta: " you build..." }
    │  content_block_stop[0] → yield AssistantMessage（文本）
    │  content_block_start[1] { type: 'tool_use', name: 'Read' }
    │  content_block_delta[1] { input_json_delta: '{"file' }
    │  content_block_delta[1] { input_json_delta: '_path":"package.json"}' }
    │  content_block_stop[1] → yield AssistantMessage（含 tool_use）
    │
    ▼
query.ts 检测到 tool_use → canUseTool() → tool.call()
    │  ReadTool 读取 package.json
    │  → 追加 tool_result UserMessage
    │  → 继续下一轮 API 调用
    │
    ▼
最终 stop_reason = "end_turn" → 返回结果
```
