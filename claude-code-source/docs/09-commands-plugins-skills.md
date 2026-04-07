# 命令、插件与 Skill 系统

## 斜杠命令（`src/commands/`）

斜杠命令是用户在 REPL 中输入 `/xxx` 触发的本地命令，不经过 Claude API。

### 命令注册

```typescript
// src/commands.ts
type Command = {
  name: string
  description: string
  aliases?: string[]
  isEnabled(): boolean
  call(args, context): Promise<CommandResult>
  // ...
}

getCommands()  // 返回所有可用命令列表
```

### 主要命令分类

| 类别 | 命令 | 说明 |
|------|------|------|
| 会话管理 | `/clear`, `/resume`, `/compact` | 清空/恢复/压缩对话 |
| 配置 | `/config`, `/model`, `/theme` | 修改配置 |
| 权限 | `/permissions`, `/plan` | 权限模式切换 |
| MCP | `/mcp` | MCP 服务器管理 |
| 插件 | `/plugin`, `/reload-plugins` | 插件管理 |
| 记忆 | `/memory` | 记忆文件管理 |
| 调试 | `/doctor`, `/status`, `/cost` | 诊断信息 |
| 远程 | `/remote-control` | 启动 Bridge |
| 导出 | `/export` | 导出对话 |
| 帮助 | `/help` | 帮助信息 |

### 命令实现示例

```typescript
// commands/compact/index.ts
export const compactCommand: Command = {
  name: 'compact',
  description: '压缩对话历史',
  isEnabled: () => true,
  async call(args, context) {
    // 触发上下文压缩
    await triggerCompact(context)
    return { type: 'success' }
  }
}
```

---

## 插件系统（`src/plugins/`、`src/utils/plugins/`）

插件扩展 Claude Code 的能力，可以添加新工具、命令、MCP 服务器。

### 插件类型

```typescript
type LoadedPlugin = {
  id: string
  name: string
  version: string
  tools?: Tool[]
  commands?: Command[]
  mcpServers?: McpServerConfig[]
  skills?: SkillDefinition[]
}
```

### 插件加载流程

```
pluginLoader.ts::loadAllPlugins()
  │
  ├── 扫描插件目录（~/.claude/plugins/）
  ├── 读取 plugin.json 清单
  ├── 验证版本兼容性
  ├── 加载工具/命令/MCP 配置
  └── 注册到 AppState.plugins
```

### 插件目录结构

```
~/.claude/plugins/
└── my-plugin/
    ├── plugin.json      # 清单文件
    ├── tools/           # 自定义工具
    ├── commands/        # 自定义命令
    └── skills/          # 自定义 Skill
```

### 内置插件（`plugins/bundled/`）

随 Claude Code 打包的官方插件，通过 `initBuiltinPlugins()` 初始化。

### 插件市场

```typescript
// services/plugins/pluginCliCommands.ts
// 支持从官方市场安装插件
VALID_INSTALLABLE_SCOPES  // 可安装的作用域
VALID_UPDATE_SCOPES       // 可更新的作用域
```

---

## Skill 系统（`src/skills/`）

Skill 是预定义的任务模板，让 Claude 能执行复杂的多步骤操作。

### Skill 定义

```typescript
// skills/loadSkillsDir.ts
type SkillDefinition = {
  name: string
  description: string
  prompt: string          // 注入到系统提示的指令
  tools?: string[]        // 允许使用的工具
  // ...
}
```

### Skill 加载

```typescript
// 扫描目录中的 .md 文件作为 Skill 定义
loadSkillsDir(dir)
  │
  ├── ~/.claude/skills/     # 用户 Skill
  ├── <project>/.claude/skills/  # 项目 Skill
  └── bundled skills        # 内置 Skill
```

### SkillTool（`tools/SkillTool/`）

```typescript
// 模型通过 SkillTool 调用 Skill
// 输入：skill 名称 + 参数
// 执行：将 Skill 的 prompt 注入上下文，触发相应操作
```

### 内置 Skill（`skills/bundled/`）

通过 `initBundledSkills()` 初始化的官方 Skill 集合。

### Skill 变更检测

```typescript
// utils/skills/skillChangeDetector.ts
// 监听 Skill 文件变化，自动重新加载
skillChangeDetector.initialize()
```

---

## 输出样式（`src/outputStyles/`）

```typescript
// outputStyles/loadOutputStylesDir.ts
// 加载自定义输出样式定义
// 影响 Claude 的响应格式（Markdown、纯文本等）
```

---

## 键绑定系统（`src/keybindings/`）

```typescript
// keybindings/defaultBindings.ts
// 默认键绑定配置

// keybindings/loadUserBindings.ts
// 加载用户自定义键绑定（~/.claude/keybindings.json）

// keybindings/resolver.ts
// 键序列解析（支持多键组合）

// keybindings/KeybindingContext.tsx
// React Context，提供键绑定给组件
```

### 默认键绑定

| 键 | 动作 |
|----|------|
| `Ctrl+C` | 取消当前操作 |
| `Ctrl+D` | 退出 |
| `Ctrl+L` | 清屏 |
| `↑/↓` | 历史导航 |
| `Tab` | 自动补全 |
| `Ctrl+R` | 历史搜索 |
| `Escape` | 关闭对话框 |
