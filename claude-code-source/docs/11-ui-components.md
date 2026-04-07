# UI 组件系统（`src/components/`）

## 概述

Claude Code 的 UI 基于 React + 自定义 Ink 渲染器，所有组件最终渲染为终端字符。

---

## 顶层组件树

```
REPL.tsx（主屏幕）
├── App.tsx（应用根组件）
│   ├── StatusLine.tsx（顶部状态栏）
│   ├── Messages.tsx（消息列表）
│   │   ├── VirtualMessageList.tsx（虚拟滚动）
│   │   └── MessageRow.tsx（单条消息）
│   │       ├── Message.tsx（消息内容）
│   │       │   ├── MessageResponse.tsx（助手响应）
│   │       │   └── [工具结果组件]
│   │       └── MessageTimestamp.tsx
│   │
│   ├── PromptInput/（输入区域）
│   │   ├── TextInput.tsx / VimTextInput.tsx
│   │   ├── ContextSuggestions.tsx（@mentions 建议）
│   │   └── PromptInputFooter（底部导航栏）
│   │
│   └── [各种对话框组件]
│
└── Doctor.tsx / ResumeConversation.tsx（其他屏幕）
```

---

## 核心组件

### Messages.tsx / VirtualMessageList.tsx

消息列表，支持虚拟滚动处理长对话：

```typescript
// 只渲染可见区域的消息
// 使用 useVirtualScroll hook
// 支持搜索高亮（GlobalSearchDialog）
```

### Message.tsx / MessageRow.tsx

单条消息渲染：

```typescript
// 根据消息类型分发渲染：
// - user: 用户输入
// - assistant: Claude 响应（含工具调用）
// - system: 系统消息（compact 边界等）
// - progress: 工具执行进度
```

### PromptInput/

用户输入区域，功能丰富：

```typescript
// 支持多行输入
// @mentions 文件/目录引用
// 历史导航（↑/↓）
// Vim 模式（VimTextInput）
// 粘贴处理（图片、文件）
// 提示建议（AI 生成）
```

### StatusLine.tsx

顶部状态栏，显示：
- 当前模型
- Token 用量
- 权限模式
- Bridge 状态
- 任务数量

---

## 工具 UI 组件

每个工具都有对应的 UI 组件，通过 `renderToolUseMessage` / `renderToolResultMessage` 渲染：

### 文件操作

```typescript
// FileEditToolDiff.tsx - 显示文件编辑 diff
// FileEditToolUpdatedMessage.tsx - 编辑成功提示
// FileEditToolUseRejectedMessage.tsx - 编辑被拒绝
// StructuredDiff.tsx / StructuredDiffList.tsx - 结构化 diff 显示
```

### 代码高亮

```typescript
// HighlightedCode.tsx - 代码语法高亮
// components/HighlightedCode/ - 高亮实现
// native-ts/color-diff/ - 颜色差异计算
```

### 进度显示

```typescript
// Spinner.tsx - 加载动画
// BashModeProgress.tsx - Bash 执行进度
// AgentProgressLine.tsx - Agent 执行进度
// TeleportProgress.tsx - Teleport 进度
```

---

## 对话框组件

| 组件 | 触发条件 |
|------|---------|
| `TrustDialog` | 首次运行，建立信任 |
| `MCPServerApprovalDialog` | 新 MCP 服务器需要批准 |
| `BypassPermissionsModeDialog` | 进入 bypass 权限模式 |
| `AutoModeOptInDialog` | 首次使用 auto 模式 |
| `BridgeDialog` | Bridge 连接状态 |
| `CostThresholdDialog` | 费用超出阈值 |
| `InvalidSettingsDialog` | 设置文件格式错误 |
| `TeleportRepoMismatchDialog` | Teleport 仓库不匹配 |
| `WorktreeExitDialog` | 退出 worktree 确认 |
| `ExportDialog` | 导出对话 |
| `GlobalSearchDialog` | 全局搜索 |
| `HistorySearchDialog` | 历史搜索 |
| `QuickOpenDialog` | 快速打开文件 |

---

## 权限 UI（`components/permissions/`）

```typescript
// 权限请求对话框
// 显示工具名称、操作描述
// 提供 Allow / Deny / Always Allow 选项
// 支持 "Allow for this session" 规则
```

---

## 设置 UI（`components/Settings/`）

```typescript
// 设置面板
// 模型选择（ModelPicker）
// 主题选择（ThemePicker）
// 输出样式（OutputStylePicker）
// 语言选择（LanguagePicker）
```

---

## 任务 UI（`components/tasks/`）

```typescript
// TaskListV2.tsx - 任务列表
// 显示后台任务状态
// 支持展开查看任务输出
// 支持停止任务
```

---

## 团队 UI（`components/teams/`）

```typescript
// Agent Swarm 团队视图
// 显示各 Agent 状态
// 支持切换查看不同 Agent 的消息历史
```

---

## MCP UI（`components/mcp/`）

```typescript
// MCP 服务器管理界面
// 显示连接状态
// 工具列表
// 资源列表
```

---

## 记忆 UI（`components/memory/`）

```typescript
// 记忆文件管理界面
// 显示已加载的 CLAUDE.md 文件
// 支持编辑记忆
```

---

## 设计系统（`components/design-system/`）

基础 UI 组件库：

```typescript
// 颜色系统
// 间距规范
// 排版规范
// 图标（components/LogoV2/）
```

---

## 主题系统（`utils/theme.ts`）

```typescript
type ThemeName = 'dark' | 'light' | 'dark-daltonism' | 'light-daltonism'

type Theme = {
  // 颜色 token
  primary: string
  secondary: string
  error: string
  warning: string
  success: string
  // ...
}

resolveThemeSetting(setting)  // 解析主题设置（含系统主题检测）
```
