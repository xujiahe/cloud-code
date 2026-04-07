# 记忆与上下文系统深度解析

## 一、整体架构

Claude Code 的记忆与上下文系统分为两个维度：

```
┌─────────────────────────────────────────────────────────────────┐
│                    上下文（Context）                              │
│  每次 API 调用时注入，影响当前对话                                  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 系统提示      │  │ 用户上下文    │  │ 系统上下文            │  │
│  │ (System      │  │ (User        │  │ (System Context)     │  │
│  │  Prompt)     │  │  Context)    │  │                      │  │
│  │              │  │              │  │                      │  │
│  │ - 工具描述    │  │ - CLAUDE.md  │  │ - git status         │  │
│  │ - 权限说明    │  │ - 记忆提示    │  │ - 当前日期           │  │
│  │ - 行为指令    │  │ - 当前日期    │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    记忆（Memory）                                 │
│  跨会话持久化，影响未来对话                                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ CLAUDE.md    │  │ auto memory  │  │ 嵌套记忆              │  │
│  │ 指令文件      │  │ 持久化记忆    │  │ (nested_memory)      │  │
│  │              │  │              │  │                      │  │
│  │ - 项目规范    │  │ - user 类型  │  │ - 子目录 CLAUDE.md   │  │
│  │ - 用户偏好    │  │ - feedback   │  │ - 按需加载           │  │
│  │ - 团队约定    │  │ - project    │  │                      │  │
│  │              │  │ - reference  │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、CLAUDE.md 指令文件系统（`utils/claudemd.ts`）

### 文件加载层级与优先级

```
优先级（低 → 高，后加载的优先级更高）：

1. Managed（企业策略）
   /etc/claude-code/CLAUDE.md
   /etc/claude-code/.claude/rules/*.md

2. User（用户全局）
   ~/.claude/CLAUDE.md
   ~/.claude/rules/*.md

3. Project（项目，从根目录向 CWD 遍历）
   <root>/CLAUDE.md
   <root>/.claude/CLAUDE.md
   <root>/.claude/rules/*.md
   ...（每个父目录重复）
   <cwd>/CLAUDE.md
   <cwd>/.claude/CLAUDE.md
   <cwd>/.claude/rules/*.md

4. Local（本地私有，不提交 git）
   <dir>/CLAUDE.local.md（每个目录）

5. Additional（--add-dir 指定的额外目录）
   <add-dir>/.claude/CLAUDE.md
```

### 文件加载流程

```typescript
getMemoryFiles()  [memoized]
    │
    ├── processMemoryFile(managedClaudeMd, 'Managed', ...)
    │     ├── 读取文件内容
    │     ├── parseFrontmatterPaths()  → 提取 paths 字段（条件规则）
    │     ├── stripHtmlComments()     → 去除 HTML 注释
    │     ├── extractIncludePathsFromTokens()  → 解析 @include 指令
    │     └── 递归处理 @include 引用的文件（最深 5 层）
    │
    ├── processMemoryFile(userClaudeMd, 'User', ...)
    │
    ├── [遍历 CWD 到根目录的每个目录]
    │     ├── processMemoryFile(CLAUDE.md, 'Project', ...)
    │     ├── processMemoryFile(.claude/CLAUDE.md, 'Project', ...)
    │     ├── processMdRules(.claude/rules/, 'Project', ...)
    │     └── processMemoryFile(CLAUDE.local.md, 'Local', ...)
    │
    └── 返回 MemoryFileInfo[] 数组（按优先级排序）
```

### @include 指令解析

```typescript
// CLAUDE.md 中可以引用其他文件
// 语法：@path, @./relative, @~/home, @/absolute

// 例如：
// @./coding-standards.md
// @~/global-preferences.md
// @/etc/company-rules.md

extractIncludePathsFromTokens(tokens, basePath)
    // 使用 marked Lexer 解析 Markdown
    // 跳过代码块（code/codespan）中的 @path
    // 跳过 HTML 注释中的 @path
    // 最大递归深度：5 层
    // 循环引用检测：processedPaths Set
```

### 条件规则（paths frontmatter）

```markdown
---
paths:
  - "src/**"
  - "tests/**"
---

# 测试规范
只在 src/ 或 tests/ 目录下的文件被访问时，才将此规则注入上下文。
```

```typescript
// 条件规则存储在 MemoryFileInfo.globs 字段
// 通过 getConditionalRulesForCwdLevelDirectory() 获取
// 当模型访问匹配路径的文件时，通过 nested_memory 附件注入
```

### 内容处理

```typescript
parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
    │
    ├── 1. 解析 frontmatter（paths 字段）
    ├── 2. stripHtmlComments()  → 去除 <!-- --> 注释
    │         使用 marked Lexer，只去除块级注释
    │         保留代码块内的注释
    ├── 3. [AutoMem/TeamMem] truncateEntrypointContent()
    │         最多 200 行 / 25000 字节
    │         超出时追加截断警告
    └── 4. 标记 contentDiffersFromDisk（用于缓存失效）
```

---

## 三、用户上下文构建（`context.ts`）

### getUserContext()

```typescript
getUserContext()  [memoized，会话级缓存]
    │
    ├── getMemoryFiles()  → 加载所有 CLAUDE.md 文件
    │
    ├── filterInjectedMemoryFiles()
    │     → 过滤掉已通过 nested_memory 附件注入的文件
    │     → 避免重复注入
    │
    ├── getClaudeMds(filteredFiles)
    │     → 将 MemoryFileInfo[] 合并为单一字符串
    │     → 格式：
    │       <system-reminder>
    │       Codebase and user instructions are shown below...
    │       <claude_md type="Managed" path="...">...</claude_md>
    │       <claude_md type="User" path="...">...</claude_md>
    │       <claude_md type="Project" path="...">...</claude_md>
    │       </system-reminder>
    │
    └── 返回 { claudeMd: string, currentDate: string }
```

### getSystemContext()

```typescript
getSystemContext()  [memoized，会话级缓存]
    │
    ├── getGitStatus()  [memoized]
    │     ├── git status --short
    │     ├── git log --oneline -n 5
    │     ├── git branch（当前分支）
    │     ├── git config user.name
    │     └── 截断超过 2000 字符的 status
    │
    └── 返回 { gitStatus: string }
```

### 注入到 API 请求

```typescript
// api.ts::prependUserContext()
// 将 userContext 作为第一条用户消息注入（isMeta: true）

prependUserContext(messages, userContext)
    → [
        {
          type: 'user',
          isMeta: true,  // 模型可见，但 UI 不显示
          content: `<system-reminder>
            As you answer the user's questions, you can use the following context:
            # claudeMd
            <claude_md ...>...</claude_md>
            # currentDate
            Today's date is 2026-04-02.
            </system-reminder>`
        },
        ...messages
      ]

// api.ts::appendSystemContext()
// 将 systemContext 追加到系统提示末尾
appendSystemContext(systemPrompt, systemContext)
    → [...systemPrompt, "gitStatus: Current branch: main\n..."]
```

---

## 四、Auto Memory 系统（`memdir/`）

### 目录结构

```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md              # 索引文件（最多 200 行 / 25KB）
├── user_role.md           # user 类型记忆
├── feedback_testing.md    # feedback 类型记忆
├── project_deadline.md    # project 类型记忆
├── reference_linear.md    # reference 类型记忆
└── logs/                  # KAIROS 模式的日志（按日期）
    └── 2026/04/2026-04-02.md
```

### 记忆类型分类

```typescript
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

// user：用户角色、偏好、知识背景
// feedback：用户对 Claude 行为的纠正和确认
// project：项目进展、决策、截止日期（不可从代码推导的信息）
// reference：外部系统指针（Linear、Grafana、Slack 等）

// 记忆文件格式：
---
name: 用户偏好 - 简洁回复
description: 用户不喜欢在回复末尾总结已做的事情
type: feedback
---

不要在回复末尾总结刚才做的事情。

**Why:** 用户说"我能看到 diff"，不需要重复。
**How to apply:** 每次回复结束时，不要加"我已经完成了..."这样的总结。
```

### 记忆路径解析（`memdir/paths.ts`）

```typescript
getAutoMemPath()  [memoized by projectRoot]
    │
    ├── 优先级 1：CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量
    │     → Cowork 用于将记忆重定向到空间级挂载点
    │
    ├── 优先级 2：settings.json 的 autoMemoryDirectory 字段
    │     → 支持 ~/ 展开
    │     → 安全验证：拒绝相对路径、根目录、UNC 路径
    │     → 注意：projectSettings 被排除（防止恶意仓库写入 ~/.ssh）
    │
    └── 优先级 3：默认路径
          findCanonicalGitRoot(projectRoot)  → 所有 worktree 共享同一记忆
          → ~/.claude/projects/<sanitized-git-root>/memory/
```

### 记忆系统提示注入

```typescript
loadMemoryPrompt()
    │
    ├── [KAIROS 模式] buildAssistantDailyLogPrompt()
    │     → 追加写入日志文件，不维护 MEMORY.md 索引
    │
    ├── [TEAMMEM 模式] buildCombinedMemoryPrompt()
    │     → 同时包含 auto memory 和 team memory 目录
    │
    └── [普通模式] buildMemoryLines() + MEMORY.md 内容
          │
          ├── 目录说明（已存在，直接写入）
          ├── 记忆类型说明（4 种类型的 XML 格式）
          ├── 不应保存的内容（代码模式、git 历史等）
          ├── 保存步骤（写文件 + 更新 MEMORY.md 索引）
          ├── 访问时机（何时读取记忆）
          ├── 信任召回（验证记忆中的文件/函数是否仍存在）
          └── MEMORY.md 当前内容（截断到 200 行）
```

---

## 五、相关记忆召回（`memdir/findRelevantMemories.ts`）

### 召回流程

```
用户发送消息
    │
    ▼
startRelevantMemoryPrefetch(messages, toolUseContext)
    │  [异步预取，与 API 调用并行]
    │
    ├── 1. scanMemoryFiles(memoryDir, signal)
    │         读取所有 .md 文件的 frontmatter（前 30 行）
    │         返回 MemoryHeader[]（按 mtime 降序，最多 200 个）
    │
    ├── 2. 过滤已在本会话中展示过的记忆（alreadySurfaced）
    │
    ├── 3. selectRelevantMemories(query, memories, signal, recentTools)
    │         调用 Sonnet 模型（sideQuery）
    │         输入：用户查询 + 记忆清单（文件名 + 描述）
    │         输出：最多 5 个相关文件名（JSON Schema 强制格式）
    │         系统提示：
    │           "只选择明确有用的记忆，不确定的不选"
    │           "如果用户正在使用某工具，不选该工具的参考文档"
    │
    └── 4. 返回 RelevantMemory[]（path + mtimeMs）
```

### 记忆注入为附件

```typescript
// attachments.ts 中的 relevant_memories 附件
{
  type: 'relevant_memories',
  memories: [
    {
      path: '/home/user/.claude/projects/.../memory/feedback_testing.md',
      content: '---\nname: ...\n---\n不要 mock 数据库...',
      mtimeMs: 1743600000000,
      header: 'saved 3 days ago · memory/feedback_testing.md',
      limit: undefined  // 未截断
    }
  ]
}

// 注入限制：
// - 每个文件最多 200 行 / 4096 字节
// - 每轮最多 5 个文件
// - 会话累计最多 60KB（超出后停止预取）
```

### 记忆新鲜度提示（`memdir/memoryAge.ts`）

```typescript
// 超过 1 天的记忆会附加新鲜度警告
memoryFreshnessText(mtimeMs)
    → "This memory is 47 days old. Memories are point-in-time observations,
       not live state — claims about code behavior or file:line citations
       may be outdated. Verify against current code before asserting as fact."

// 目的：防止模型将过时的记忆（如已删除的函数）当作事实断言
```

---

## 六、嵌套记忆（Nested Memory）

### 触发机制

```typescript
// 当模型读取某目录下的文件时，自动加载该目录的 CLAUDE.md

// 触发条件：
// 1. FileReadTool 读取文件
// 2. FileEditTool 编辑文件
// 3. 用户 @mention 文件

// 追踪集合：
toolUseContext.nestedMemoryAttachmentTriggers  // 已触发的目录
toolUseContext.loadedNestedMemoryPaths         // 已加载的 CLAUDE.md 路径
```

### 嵌套记忆加载

```typescript
getNestedMemoryAttachments(context)
    │
    ├── 遍历 nestedMemoryAttachmentTriggers（触发的文件路径）
    │
    ├── getMemoryFilesForNestedDirectory(filePath)
    │     → 从文件路径向上遍历到 CWD
    │     → 查找每个目录的 .claude/CLAUDE.md
    │     → 过滤已加载的路径（loadedNestedMemoryPaths）
    │
    └── 返回 nested_memory 附件
          {
            type: 'nested_memory',
            path: 'src/auth/.claude/CLAUDE.md',
            content: { path, type: 'Project', content: '...' },
            displayPath: 'src/auth/.claude/CLAUDE.md'
          }
```

---

## 七、记忆提取（Extract Memories）

### 触发时机

```typescript
// 每次对话轮次结束时（stop_reason = 'end_turn'）
// 通过 handleStopHooks → executeExtractMemories()

// 触发条件：
// 1. GrowthBook 功能开关 tengu_passport_quail = true
// 2. isAutoMemoryEnabled() = true
// 3. 非远程模式
// 4. 主 Agent（非子 Agent）
// 5. 主 Agent 本轮未直接写入记忆文件
```

### 提取流程

```typescript
executeExtractMemories(context, appendSystemMessage)
    │
    ├── 防重入检查（inProgress 标志）
    │     → 如果正在提取，stash 当前 context，等待完成后再运行
    │
    ├── 节流检查（tengu_bramble_lintel，默认每轮运行）
    │
    ├── scanMemoryFiles()  → 获取现有记忆清单
    │
    ├── buildExtractAutoOnlyPrompt(newMessageCount, existingMemories)
    │     → 构建提取提示词：
    │       "分析最近 N 条消息，提取值得保存的记忆"
    │       "现有记忆清单：[文件名 + 描述]"
    │       "不要重复已有记忆，优先更新而非新建"
    │
    ├── runForkedAgent({
    │     promptMessages: [提取提示词],
    │     cacheSafeParams: createCacheSafeParams(context),
    │     canUseTool: createAutoMemCanUseTool(memoryDir),
    │     querySource: 'extract_memories',
    │     maxTurns: 5,
    │     skipTranscript: true,
    │   })
    │     → 子 Agent 只能：
    │       - Read/Grep/Glob（无限制）
    │       - 只读 Bash 命令
    │       - FileEdit/FileWrite（仅限 memory 目录）
    │
    ├── extractWrittenPaths(agentMessages)
    │     → 收集子 Agent 写入的文件路径
    │
    └── appendSystemMessage(createMemorySavedMessage(memoryPaths))
          → 在主对话中显示 "Saved N memories" 系统消息
```

### 提示缓存共享

```typescript
createCacheSafeParams(context)
    // 子 Agent 使用与主 Agent 相同的系统提示
    // 共享提示缓存（cache_read_input_tokens 高）
    // 避免重复计算工具描述等静态内容
```

---

## 八、Auto Dream（记忆整合）

### 触发条件

```typescript
// 每次对话轮次结束时检查
// 条件（按成本从低到高）：
// 1. 距上次整合 >= 24 小时（读取一个文件的 mtime）
// 2. 自上次整合以来 >= 5 个新会话（扫描 sessions/ 目录）
// 3. 获取整合锁（防止并发）
```

### 整合流程

```typescript
executeAutoDream(context, appendSystemMessage)
    │
    ├── 时间门控：readLastConsolidatedAt()
    │     → 读取 ~/.claude/projects/.../memory/.consolidation-lock 的 mtime
    │
    ├── 会话门控：listSessionsTouchedSince(lastAt)
    │     → 扫描 ~/.claude/sessions/ 目录
    │     → 统计 mtime > lastAt 的会话数
    │
    ├── 获取锁：tryAcquireConsolidationLock()
    │     → 原子写入锁文件（防止多进程并发）
    │
    ├── buildConsolidationPrompt(memoryRoot, transcriptDir, extra)
    │     → 构建整合提示词：
    │       "审查最近 N 个会话的 transcript"
    │       "整合、去重、更新 MEMORY.md 索引"
    │       "将日志文件提炼为主题文件"
    │
    ├── runForkedAgent({
    │     querySource: 'auto_dream',
    │     canUseTool: createAutoMemCanUseTool(memoryRoot),
    │     maxTurns: 无限制（整合可能需要多轮）
    │   })
    │
    └── completeDreamTask() → 更新 AppState 中的 DreamTask 状态
```

---

## 九、上下文注入的完整时序

```
用户发送消息
    │
    ▼
processUserInput()
    │
    ├── getAttachmentMessages()
    │     │
    │     ├── [用户输入附件]
    │     │     ├── processAtMentionedFiles()  → @file 引用
    │     │     └── processAgentMentions()     → @agent 引用
    │     │
    │     ├── [系统附件（每轮）]
    │     │     ├── getNestedMemoryAttachments()  → 嵌套 CLAUDE.md
    │     │     ├── getDynamicSkillAttachments()  → 动态发现的 Skill
    │     │     ├── getSkillListingAttachments()  → Skill 列表更新
    │     │     ├── getPlanModeAttachments()      → 计划模式提醒
    │     │     ├── getTodoReminderAttachments()  → TODO 提醒
    │     │     ├── getChangedFiles()             → 文件变更检测
    │     │     └── getDateChangeAttachments()    → 日期变更通知
    │     │
    │     └── [异步预取（与 API 并行）]
    │           └── startRelevantMemoryPrefetch()
    │                 → findRelevantMemories()
    │                 → 在 API 响应前完成
    │
    ▼
query()
    │
    ├── fetchSystemPromptParts()
    │     ├── getSystemPrompt(tools, model, ...)
    │     │     → 工具描述 + 权限说明 + 记忆系统提示
    │     │     → loadMemoryPrompt() 注入 MEMORY.md 内容
    │     │
    │     ├── getUserContext()
    │     │     → CLAUDE.md 内容 + 当前日期
    │     │
    │     └── getSystemContext()
    │           → git status + 分支信息
    │
    ├── prependUserContext(messages, userContext)
    │     → 将 CLAUDE.md 作为第一条 isMeta 用户消息
    │
    ├── appendSystemContext(systemPrompt, systemContext)
    │     → 将 git status 追加到系统提示末尾
    │
    └── API 调用
          系统提示 = [工具描述] + [记忆系统提示] + [git status]
          消息[0] = <system-reminder>CLAUDE.md + 日期</system-reminder>
          消息[1..] = 对话历史 + 附件（嵌套记忆、相关记忆等）
```

---

## 十、记忆系统的缓存策略

### 提示缓存（Prompt Cache）

```typescript
// CLAUDE.md 内容通过 userContext 注入为第一条消息
// 这条消息有 cache_control: { type: 'ephemeral' }
// 只要 CLAUDE.md 不变，这部分缓存命中率极高

// MEMORY.md 内容注入到系统提示中
// 系统提示有 cache_control: { type: 'ephemeral', scope: 'global' }
// 全局缓存：所有用户共享（当内容相同时）
```

### 文件状态缓存（FileStateCache）

```typescript
// readFileState 缓存已读取的文件内容和 mtime
// 用于检测文件变更（getChangedFiles 附件）
// 嵌套记忆加载后写入缓存（避免重复读取）

// contentDiffersFromDisk 标志：
// 当 CLAUDE.md 内容被处理（去注释、截断）后与磁盘不同
// 此时写入 isPartialView: true 的缓存条目
// FileEditTool 在编辑前需要先 Read（不能基于部分视图编辑）
```

### 记忆召回的会话预算

```typescript
RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES: 60 * 1024  // 60KB 会话累计上限
}

// 超出后停止预取
// compact 后自然重置（旧附件从上下文中消失）
// 防止长会话中记忆注入无限增长
```

---

## 十一、团队记忆（Team Memory）

```typescript
// TEAMMEM 功能开关控制
// 团队记忆目录：~/.claude/projects/.../memory/team/

// 记忆类型的 scope 字段：
// - user：始终 private（个人偏好）
// - feedback：默认 private，项目约定可 team
// - project：强烈建议 team
// - reference：通常 team

// 团队记忆同步（services/teamMemorySync/）：
// 通过 git 或共享文件系统同步 team/ 目录
// 多个开发者共享项目记忆和参考资料
```
