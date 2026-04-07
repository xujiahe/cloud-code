# Skill、命令与代码交互深度解析

## 一、三者的本质区别

```
命令（Command）
├── LocalCommand      → 本地执行，返回文本，不调用 API
├── LocalJSXCommand   → 本地执行，渲染 Ink UI，不调用 API
└── PromptCommand     → 展开为 prompt，发给 Claude API（这就是 Skill）

Skill = PromptCommand 的别称
  - 来源：磁盘文件（SKILL.md）、内置（bundled）、插件（plugin）、MCP
  - 执行：展开内容注入对话，或在子 Agent 中执行（fork 模式）

插件（Plugin）
  - 可以包含：工具 + 命令 + Skill + MCP 服务器
  - 是一个打包单元，不是独立的执行类型
```

---

## 二、Skill 的两种调用路径

### 路径 1：用户直接调用（斜杠命令）

```
用户输入 "/review-pr 123"
    │
    ▼
processUserInput() → processSlashCommand()
    │
    ├── findCommand("review-pr") → PromptCommand
    ├── command.getPromptForCommand("123", ctx)
    │     → 返回 ContentBlockParam[]
    │
    ├── 构建 UserMessage：
    │     {
    │       type: 'user',
    │       message: {
    │         content: '<command-message>/review-pr 123</command-message>\n\n<skill-content>...'
    │       }
    │     }
    │
    └── 返回 { messages: [userMsg], shouldQuery: true, allowedTools, model }
          │
          ▼
    query() → API 调用（模型看到 Skill 内容）
```

### 路径 2：模型主动调用（SkillTool）

```
模型决定调用 SkillTool({ skill: "review-pr", args: "123" })
    │
    ▼
SkillTool.call()
    │
    ├── [inline] processPromptSlashCommand("review-pr", "123", commands, ctx)
    │     → 同路径 1，但返回 ToolResult.newMessages
    │     → query.ts 将 newMessages 追加到对话历史
    │     → 下一轮 API 调用时模型看到 Skill 内容
    │
    └── [fork] executeForkedSkill()
          → runAgent() 启动子 Agent
          → 子 Agent 独立执行 Skill
          → 返回子 Agent 的最终文本输出
```

---

## 三、Skill 内容如何影响模型行为

### inline 模式的消息结构

```
对话历史（发给 API 的消息）：

[user] 用户原始问题
[assistant] 好的，我来帮你审查 PR
[user] <command-message>/review-pr 123</command-message>
       Base directory for this skill: /home/user/.claude/skills/review-pr

       # Review PR

       Please review PR $ARGUMENTS and provide feedback on:
       1. Code quality
       2. Test coverage

       [Skill 内容展开后的完整文本]
[assistant] 我来审查 PR #123...
            [模型根据 Skill 内容执行操作]
```

### allowedTools 的作用

```typescript
// Skill 的 allowed-tools frontmatter 字段
// 通过 contextModifier 更新 ToolPermissionContext

SkillTool.call() 返回：
{
  data: { success: true, commandName, allowedTools: ['Read', 'Bash'] },
  newMessages: [...],
  contextModifier(ctx) {
    // 将 allowedTools 添加到 alwaysAllowRules
    return {
      ...ctx,
      getAppState() {
        return {
          ...ctx.getAppState(),
          toolPermissionContext: {
            ...ctx.getAppState().toolPermissionContext,
            alwaysAllowRules: {
              ...ctx.getAppState().toolPermissionContext.alwaysAllowRules,
              command: [...existingRules, ...allowedTools],
            },
          },
        }
      },
    }
  },
}

// 效果：Skill 执行期间，Read 和 Bash 工具自动允许，无需用户确认
```

---

## 四、Skill 的 Hooks 机制

```typescript
// SKILL.md frontmatter 中定义 hooks
---
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "echo 'Bash executed: $TOOL_INPUT'"
  PreToolUse:
    - matcher: "FileEdit"
      hooks:
        - type: ask
          prompt: "Verify this edit is safe"
---

// 注册时机：processPromptSlashCommand() 中
registerSkillHooks(command, toolUseContext)
  // 将 hooks 注册到 AppState.sessionHooks
  // 工具调用前后自动触发
```

---

## 五、动态 Skill 发现

```typescript
// 当模型读取/编辑文件时，自动发现相关 Skill

// FileReadTool.call() 执行后：
// 1. 记录访问的文件路径
// 2. discoverSkillDirsForPaths(filePaths, cwd)
//    → 从文件路径向上遍历
//    → 发现 .claude/skills/ 目录
//    → 加载新 Skill

// 条件 Skill 激活：
// SKILL.md 中有 paths: ["src/**"]
// 当模型访问 src/ 下的文件时，该 Skill 自动激活
// 加入 dynamicSkills，在下一次 getCommands() 时可用

// 系统提示中的 Skill 列表会更新
// 模型在下一轮可以看到新激活的 Skill
```

---

## 六、Skill 在系统提示中的呈现

```typescript
// SkillTool.prompt() 生成系统提示中的 Skill 列表
// getPrompt(cwd) → 读取所有可用 Skill

// 系统提示片段（简化）：
`
## Available Skills

You can invoke skills using the ${SKILL_TOOL_NAME} tool.

Available skills:
- review-pr: Review a PR and provide feedback
  When to use: When user asks to review a PR
  Allowed tools: Read, Bash, WebFetch

- claude-api: Build apps with the Claude API
  When to use: When code imports anthropic or user asks about Claude API
  Allowed tools: Read, Grep, Glob, WebFetch

- commit: Create a git commit with a good message
  When to use: When user wants to commit changes
`

// 模型根据这个列表决定何时调用 SkillTool
```

---

## 七、命令与 Skill 的系统提示注入

### 命令列表注入

```typescript
// 系统提示中包含所有可用命令
// constants/prompts.ts::getSystemPrompt()

// 命令以 XML 格式注入：
`
<commands>
  <command name="compact" description="Compact conversation history" />
  <command name="clear" description="Clear conversation" />
  <command name="review-pr" description="Review a PR" source="skill" />
  ...
</commands>
`
```

### Skill 的 whenToUse 字段

```typescript
// whenToUse 是给模型的触发条件说明
// 出现在 SkillTool 的系统提示中

// 例如 claude-api Skill：
description: 'Build apps with the Claude API...\n' +
  'TRIGGER when: code imports `anthropic`/`@anthropic-ai/sdk`...\n' +
  'DO NOT TRIGGER when: code imports `openai`/other AI SDK...'

// 模型根据这个描述决定是否主动调用 SkillTool
```

---

## 八、fork 模式的子 Agent 执行

```typescript
// context: fork 的 Skill 在独立子 Agent 中执行

executeForkedSkill(command, commandName, args, context, canUseTool, ...)
    │
    ├── prepareForkedCommandContext(command, args, context)
    │     ├── 获取 Skill 内容（getPromptForCommand）
    │     ├── 创建子 Agent 定义（agentDefinition）
    │     └── 构建初始消息（promptMessages）
    │
    ├── runAgent({
    │     agentDefinition,
    │     promptMessages,
    │     toolUseContext: { ...context, getAppState: modifiedGetAppState },
    │     canUseTool,
    │     isAsync: false,
    │     querySource: 'agent:custom',
    │     model: command.model,
    │   })
    │
    ├── 收集子 Agent 的所有消息
    ├── 报告进度（onProgress）
    │
    └── extractResultText(agentMessages)
          → 提取最终文本输出
          → 返回给父 Agent 作为 ToolResult
```

### fork 模式的 token 预算

```typescript
// fork 模式有独立的 token 预算
// 不消耗父 Agent 的 context window

// 子 Agent 的 context window：
// - 默认：模型的最大 context window
// - 可通过 Skill 的 effort 字段调整

// 父 Agent 只看到子 Agent 的最终输出文本
// 不看到子 Agent 的中间步骤（除非 preserveToolUseResults: true）
```

---

## 九、MCP Skill 的特殊处理

```typescript
// MCP 服务器可以提供 Skill（通过 prompts/list）
// 这些 Skill 被包装为 PromptCommand

// MCP Skill 的限制：
// 1. 不执行内联 shell 命令（!`...` 语法）
//    因为 MCP 是远程/不可信来源
// 2. 不支持 ${CLAUDE_SKILL_DIR} 变量
// 3. 需要 MCP_SKILLS 功能开关

// MCP Skill 的加载：
// services/mcp/client.ts → getMcpToolsCommandsAndResources()
// → 调用 prompts/list
// → 每个 prompt 包装为 PromptCommand
// → loadedFrom: 'mcp'
// → 注册到 AppState.mcp.commands

// SkillTool 中的 MCP Skill 获取：
getAllCommands(context)
    ├── getCommands(getProjectRoot())  → 本地 Skill
    └── context.getAppState().mcp.commands
          .filter(cmd => cmd.loadedFrom === 'mcp')  → MCP Skill
```

---

## 十、Skill 调用的完整遥测

```typescript
// 每次 Skill 调用都记录遥测事件
logEvent('tengu_skill_tool_invocation', {
  command_name: sanitizedCommandName,  // 内置/官方用真名，自定义用 'custom'
  _PROTO_skill_name: commandName,      // 真实名称（PII 标记）
  execution_context: 'inline' | 'fork',
  invocation_trigger: 'claude-proactive' | 'nested-skill',
  query_depth: queryTracking.depth,    // 嵌套深度
  was_discovered: boolean,             // 是否通过 SkillSearch 发现
  // 插件信息（如果是插件 Skill）
  plugin_name: ...,
  plugin_repository: ...,
})
```
