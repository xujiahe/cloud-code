# 插件系统深度解析

## 一、插件架构

```
插件目录结构：
~/.claude/plugins/<plugin-id>/
├── plugin.json          # 插件清单（必需）
├── tools/               # 自定义工具（可选）
│   └── MyTool.ts
├── commands/            # 自定义命令（可选）
│   └── my-command.ts
├── skills/              # 自定义 Skill（可选）
│   └── my-skill/
│       └── SKILL.md
└── mcp-servers/         # MCP 服务器（可选）
    └── server.js
```

---

## 二、plugin.json 清单格式

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "author": "username",
  "repository": "github:username/my-plugin",
  "claudeCodeVersion": ">=0.1.0",  // 兼容版本
  "main": "./index.js",            // 入口文件（可选）
  "tools": ["./tools/MyTool.ts"],  // 工具列表
  "commands": ["./commands/my-command.ts"],
  "skills": ["./skills/my-skill"],
  "mcpServers": {                  // MCP 服务器配置
    "my-server": {
      "command": "node",
      "args": ["./mcp-servers/server.js"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  },
  "dependencies": {                // npm 依赖（可选）
    "axios": "^1.0.0"
  }
}
```

---

## 三、插件加载流程（`utils/plugins/pluginLoader.ts`）

```
loadAllPlugins()
    │
    ├── 扫描插件目录
    │     ├── ~/.claude/plugins/
    │     ├── <project>/.claude/plugins/
    │     └── CLAUDE_CODE_PLUGIN_SEED_DIR 环境变量指定的目录
    │
    ├── 每个插件：
    │     ├── 读取 plugin.json
    │     ├── 验证版本兼容性（semver）
    │     ├── 检查是否被禁用（settings.json）
    │     ├── 加载工具模块（动态 import）
    │     ├── 加载命令模块
    │     ├── 加载 Skill 文件
    │     └── 解析 MCP 服务器配置
    │
    ├── 去重（按 repository 字段）
    │
    └── 返回 { enabled: LoadedPlugin[], disabled: LoadedPlugin[], errors: PluginError[] }
```

### 插件缓存机制

```typescript
// 插件加载结果缓存在内存中
loadAllPluginsCacheOnly()  // 只返回缓存，不触发网络请求

// 缓存失效时机：
// 1. /reload-plugins 命令
// 2. settings.json 变更（settingsChangeDetector）
// 3. 插件目录文件变更
```

---

## 四、插件工具注册

```typescript
// 插件工具必须导出符合 Tool 接口的对象
// tools/MyTool.ts
import { buildTool } from '@anthropic-ai/claude-code'
import { z } from 'zod'

export const MyTool = buildTool({
  name: 'my_tool',
  inputSchema: z.object({
    param: z.string(),
  }),
  async call(args, context) {
    // 工具实现
    return { data: { result: 'success' } }
  },
  // ... 其他 Tool 接口方法
})
```

### 插件工具与内置工具的合并

```typescript
// tools.ts::assembleToolPool()
assembleToolPool(permissionContext, mcpTools)
    │
    ├── getTools(permissionContext)  → 内置工具
    ├── filterToolsByDenyRules(mcpTools)  → MCP 工具（含插件 MCP）
    │
    └── uniqBy([...builtIn.sort(), ...mcp.sort()], 'name')
        // 按名称排序后合并，内置工具优先
        // 排序保证提示缓存稳定性
```

---

## 五、插件命令与 Skill

### 插件命令加载

```typescript
// utils/plugins/loadPluginCommands.ts
getPluginCommands()
    │
    ├── loadAllPlugins()
    ├── 遍历 plugin.commands
    │     └── 动态 import 命令模块
    │
    └── 返回 Command[] 数组

// 插件命令格式：
export default {
  type: 'local',  // 或 'local-jsx' / 'prompt'
  name: 'my-command',
  description: '...',
  async load() {
    return {
      async call(args, context) {
        // 命令实现
        return { type: 'text', value: 'result' }
      }
    }
  }
}
```

### 插件 Skill 加载

```typescript
// utils/plugins/loadPluginCommands.ts
getPluginSkills()
    │
    ├── loadAllPlugins()
    ├── 遍历 plugin.skills
    │     └── 读取 <skill-dir>/SKILL.md
    │
    ├── parseFrontmatter() → 解析 frontmatter
    ├── parseSkillFrontmatterFields() → 解析字段
    │
    └── createSkillCommand() → 创建 PromptCommand
```

---

## 六、插件 MCP 服务器

### MCP 配置合并

```typescript
// services/mcp/config.ts
getClaudeCodeMcpConfigs()
    │
    ├── 用户配置：~/.claude/mcp.json
    ├── 项目配置：<project>/.claude/mcp.json
    ├── 插件配置：从 plugin.json 的 mcpServers 字段
    ├── 企业配置：MDM 策略
    └── claude.ai 托管配置：fetchClaudeAIMcpConfigsIfEligible()
    │
    └── 按优先级合并（后者覆盖前者）
```

### 插件 MCP 工具动态生成

```typescript
// services/mcp/client.ts
getMcpToolsCommandsAndResources(mcpClients)
    │
    ├── 连接每个 MCP 服务器
    ├── 调用 tools/list → 获取工具列表
    │
    └── 每个工具包装为 Tool 对象：
          {
            name: 'mcp__<serverName>__<toolName>',
            isMcp: true,
            mcpInfo: { serverName, toolName },
            async call(args, context) {
              // 调用 MCP 服务器的 tools/call
              const result = await mcpClient.callTool(toolName, args)
              return { data: result }
            },
            // ...
          }
```

---

## 七、插件市场与安装

### 插件标识符格式

```typescript
// utils/plugins/pluginIdentifier.ts
type PluginIdentifier = {
  marketplace: string  // 'github' | 'npm' | 'official'
  name: string         // 插件名称
  version?: string     // 版本（可选）
}

// 格式示例：
// "github:username/repo"
// "npm:package-name"
// "official:claude-api"
```

### 插件安装流程

```
/plugin install github:username/my-plugin
    │
    ▼
services/plugins/pluginCliCommands.ts
    │
    ├── 解析插件标识符
    ├── 从市场下载（git clone / npm install）
    ├── 验证 plugin.json
    ├── 安装依赖（npm install）
    ├── 复制到 ~/.claude/plugins/<plugin-id>/
    │
    └── 更新 AppState.plugins.installationStatus
```

### 托管插件（Managed Plugins）

```typescript
// utils/plugins/managedPlugins.ts
// 企业策略可以强制安装/禁用插件
getManagedPluginNames()  // 从 MDM 策略读取

// 托管插件不能被用户卸载
// 优先级高于用户配置
```

---

## 八、插件与代码的交互

### 插件工具调用流程

```
模型调用 my_tool({ param: "value" })
    │
    ▼
query.ts → canUseTool(MyTool, input, ...)
    │
    ├── 权限检查（插件工具需要用户确认）
    │
    └── MyTool.call(input, context)
          │  context 包含：
          │  - getAppState() / setAppState()
          │  - readFileState（文件缓存）
          │  - abortController
          │  - messages（对话历史）
          │  - options.tools（所有工具）
          │
          └── 插件代码可以：
                ├── 读取/修改文件（通过 context）
                ├── 调用其他工具（通过 context.options.tools）
                ├── 更新 AppState（通过 setAppState）
                └── 发送进度更新（通过 onProgress）
```

### 插件命令调用流程

```
用户输入 "/my-command arg1 arg2"
    │
    ▼
processSlashCommand()
    │
    ├── findCommand("my-command", commands)
    │     → 找到插件命令
    │
    ├── [LocalCommand] command.load().then(m => m.call(args, ctx))
    │     → 返回 { type: 'text', value: '...' }
    │
    └── [LocalJSXCommand] command.load().then(m => m.call(onDone, ctx, args))
          → 返回 React.ReactNode（Ink UI）
          → 通过 setToolJSX() 渲染到终端
```

---

## 九、插件安全机制

### 1. 版本验证

```typescript
// 检查 plugin.json 的 claudeCodeVersion 字段
// 使用 semver 验证兼容性
// 不兼容的插件被标记为 disabled
```

### 2. 权限隔离

```typescript
// 插件工具默认需要用户确认
// 除非用户在 settings.json 中添加 allow 规则
{
  "permissions": {
    "allow": ["my_tool"]
  }
}
```

### 3. 沙箱执行

```typescript
// 插件代码在同一 Node.js 进程中运行（无隔离）
// 依赖用户信任（Trust Dialog）
// 企业可通过 MDM 策略限制插件来源
```

### 4. MCP 服务器隔离

```typescript
// 插件 MCP 服务器在独立子进程中运行
// 通过 stdio 通信（JSON-RPC）
// 子进程崩溃不影响主进程
```
