# 工具系统（Tool System）

## 概述

工具系统是 Claude Code 的核心能力层。所有工具实现 `Tool<Input, Output, Progress>` 接口，通过 `buildTool()` 工厂函数构建，统一注册到工具池。

---

## Tool 接口（`src/Tool.ts`）

### 核心方法

```typescript
type Tool<Input, Output, Progress> = {
  name: string
  aliases?: string[]           // 向后兼容的别名

  // 核心执行
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>

  // 权限检查（工具特定逻辑）
  checkPermissions(input, context): Promise<PermissionResult>

  // 输入验证
  validateInput?(input, context): Promise<ValidationResult>

  // 描述（用于系统提示）
  description(input, options): Promise<string>
  prompt(options): Promise<string>

  // 行为标志
  isEnabled(): boolean
  isConcurrencySafe(input): boolean   // 是否可并行执行
  isReadOnly(input): boolean
  isDestructive?(input): boolean

  // UI 渲染（Ink 组件）
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode

  // 工具搜索支持
  searchHint?: string          // 关键词提示，用于 ToolSearch
  shouldDefer?: boolean        // 是否延迟加载（需先用 ToolSearch）
  alwaysLoad?: boolean         // 始终在初始提示中包含

  maxResultSizeChars: number   // 超出则持久化到磁盘
}
```

### ToolUseContext（工具执行上下文）

```typescript
type ToolUseContext = {
  options: {
    tools: Tools
    commands: Command[]
    mainLoopModel: string
    mcpClients: MCPServerConnection[]
    thinkingConfig: ThinkingConfig
    // ...
  }
  abortController: AbortController
  readFileState: FileStateCache      // 文件读取缓存
  getAppState(): AppState
  setAppState(f): void
  setToolJSX?: SetToolJSXFn          // 设置工具 UI（REPL 模式）
  addNotification?: (notif) => void
  messages: Message[]                // 当前对话历史
  // ...
}
```

---

## 工具分类

### 文件操作工具

| 工具 | 功能 |
|------|------|
| `FileReadTool` | 读取文件内容，支持行范围 |
| `FileEditTool` | 精确字符串替换编辑文件 |
| `FileWriteTool` | 创建/覆写文件 |
| `NotebookEditTool` | 编辑 Jupyter Notebook |

**FileEditTool 核心细节：**
- 使用精确字符串匹配（`oldStr` → `newStr`），不是行号
- 要求 `oldStr` 在文件中唯一，防止误替换
- 支持 diff 预览（`renderToolResultMessage` 显示 diff）
- 大文件结果超过 `maxResultSizeChars` 时持久化到磁盘

### Shell 执行工具

| 工具 | 功能 |
|------|------|
| `BashTool` | 执行 bash 命令，支持超时、沙箱 |
| `PowerShellTool` | Windows PowerShell 执行 |
| `REPLTool` | Node.js VM 沙箱（ant 内部） |

**BashTool 核心细节：**
- 通过 `SandboxManager` 支持沙箱模式（macOS sandbox-exec）
- 命令超时默认 120s，可配置
- 支持后台任务（`DISABLE_BACKGROUND_TASKS` 控制）
- `isConcurrencySafe` 返回 false（串行执行）

### 搜索工具

| 工具 | 功能 |
|------|------|
| `GlobTool` | 文件路径 glob 匹配 |
| `GrepTool` | 正则内容搜索（基于 ripgrep） |
| `WebSearchTool` | 网络搜索 |
| `WebFetchTool` | 抓取网页内容 |
| `ToolSearchTool` | 在工具列表中搜索（延迟加载机制） |

### Agent/任务工具

| 工具 | 功能 |
|------|------|
| `AgentTool` | 启动子 Agent（并行/串行） |
| `TaskCreateTool` | 创建后台任务 |
| `TaskGetTool` | 获取任务状态 |
| `TaskUpdateTool` | 更新任务 |
| `TaskListTool` | 列出所有任务 |
| `TaskStopTool` | 停止任务 |
| `TaskOutputTool` | 读取任务输出 |

### 协作工具（Swarm）

| 工具 | 功能 |
|------|------|
| `TeamCreateTool` | 创建 Agent 团队 |
| `TeamDeleteTool` | 解散团队 |
| `SendMessageTool` | 向 Agent 发送消息 |

### 模式控制工具

| 工具 | 功能 |
|------|------|
| `EnterPlanModeTool` | 进入计划模式（只读） |
| `ExitPlanModeV2Tool` | 退出计划模式，提交执行计划 |
| `EnterWorktreeTool` | 进入 git worktree 隔离环境 |
| `ExitWorktreeTool` | 退出 worktree |

### MCP 工具

| 工具 | 功能 |
|------|------|
| `MCPTool` | 动态生成的 MCP 服务器工具 |
| `ListMcpResourcesTool` | 列出 MCP 资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源 |

### 其他工具

| 工具 | 功能 |
|------|------|
| `TodoWriteTool` | 管理 TODO 列表 |
| `AskUserQuestionTool` | 向用户提问（交互模式） |
| `SkillTool` | 执行预定义 Skill |
| `BriefTool` | 生成简短摘要 |
| `LSPTool` | LSP 语言服务器集成 |
| `TungstenTool` | tmux 终端控制（ant 内部） |
| `ConfigTool` | 配置管理（ant 内部） |

---

## 工具池组装（`tools.ts`）

```typescript
// 完整工具池（含 MCP 工具）
assembleToolPool(permissionContext, mcpTools): Tools
  │
  ├── getTools(permissionContext)     // 内置工具（按权限过滤）
  │     ├── getAllBaseTools()         // 所有内置工具
  │     ├── filterToolsByDenyRules() // 按拒绝规则过滤
  │     └── 按模式过滤（SIMPLE, REPL, coordinator）
  │
  ├── filterToolsByDenyRules(mcpTools) // MCP 工具权限过滤
  │
  └── uniqBy([...builtIn, ...mcp], 'name')  // 去重（内置优先）
```

### 工具延迟加载（Tool Search）

当工具数量超过阈值时，启用 `ToolSearchTool`：
- 大多数工具标记 `shouldDefer: true`，不在初始提示中出现
- 模型先调用 `ToolSearch` 找到需要的工具
- 找到后工具的完整 schema 才注入到上下文

---

## 权限系统

```typescript
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Input }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message: string }  // 需要用户确认

// 权限检查顺序：
// 1. validateInput()      - 工具特定验证
// 2. alwaysDenyRules      - 全局拒绝规则
// 3. alwaysAllowRules     - 全局允许规则
// 4. tool.checkPermissions() - 工具特定权限
// 5. 用户交互确认（REPL 模式）
// 6. hooks（PreToolUse hooks）
```

### 权限模式

```typescript
type PermissionMode =
  | 'default'      // 需要用户确认危险操作
  | 'auto'         // 自动批准（YOLO 模式）
  | 'plan'         // 只读，不执行写操作
  | 'bypassPermissions'  // 跳过所有权限检查
```
