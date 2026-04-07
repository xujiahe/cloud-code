# 配置与设置系统

## 概述

Claude Code 有多层配置系统：全局配置、项目配置、用户设置、企业策略，按优先级合并。

---

## 配置层级

```
优先级（高 → 低）：

1. CLI 参数（--model, --permission-mode 等）
2. 环境变量（ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK 等）
3. 企业策略（MDM / 注册表 / policySettings）
4. 用户设置（~/.claude/settings.json）
5. 项目设置（<project>/.claude/settings.json）
6. 全局配置（~/.claude/config.json）
7. 默认值
```

---

## 全局配置（`utils/config.ts`）

```typescript
// ~/.claude/config.json
type GlobalConfig = {
  migrationVersion: number      // 数据迁移版本
  theme: ThemeName              // UI 主题
  autoUpdaterStatus: string     // 自动更新状态
  hasCompletedOnboarding: boolean
  hasTrustDialogAccepted: boolean  // 信任对话框
  // 模型设置
  model?: string
  // 远程控制
  remoteControlAtStartup?: boolean
  // ...
}

getGlobalConfig()
saveGlobalConfig(updater)
```

---

## 用户设置（`utils/settings/`）

```typescript
// ~/.claude/settings.json（用户级）
// <project>/.claude/settings.json（项目级）
type SettingsJson = {
  // 权限规则
  permissions?: {
    allow?: string[]    // 始终允许的工具/命令
    deny?: string[]     // 始终拒绝的工具/命令
  }
  // 模型
  model?: string
  // MCP 服务器
  mcpServers?: Record<string, McpServerConfig>
  // 环境变量
  env?: Record<string, string>
  // 功能开关
  enableAllProjectMcpServers?: boolean
  // ...
}
```

### 设置来源

```typescript
// utils/settings/constants.ts
type SettingSource =
  | 'globalSettings'    // ~/.claude/settings.json
  | 'projectSettings'   // <project>/.claude/settings.json
  | 'localSettings'     // .claude/settings.local.json（不提交 git）
  | 'policySettings'    // 企业策略
  | 'flagSettings'      // --settings CLI 参数
```

### 设置合并

```typescript
getInitialSettings()
  // 按优先级合并所有来源的设置
  // 返回最终生效的 SettingsJson
```

---

## 企业策略（MDM）

### macOS（`utils/settings/mdm/`）

```typescript
// 通过 plutil 读取 MDM 配置
// 路径：/Library/Managed Preferences/com.anthropic.claudecode.plist
startMdmRawRead()  // 启动时异步预读取
ensureMdmSettingsLoaded()  // 确保加载完成
```

### Windows

```typescript
// 通过注册表读取
// HKLM\SOFTWARE\Policies\Anthropic\ClaudeCode
```

### 策略字段

```typescript
type PolicySettings = {
  allowedModels?: string[]
  disabledTools?: string[]
  allowRemoteControl?: boolean
  allowMcp?: boolean
  // ...
}
```

---

## 环境变量

### 认证

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `CLAUDE_CODE_USE_BEDROCK` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 使用 GCP Vertex AI |
| `AWS_REGION` | Bedrock 区域 |

### 行为控制

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_SIMPLE` | 简单模式（只有 Bash/Read/Edit） |
| `CLAUDE_CODE_DISABLE_THINKING` | 禁用思考模式 |
| `DISABLE_AUTO_COMPACT` | 禁用自动压缩 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `DISABLE_BACKGROUND_TASKS` | 禁用后台任务 |
| `CLAUDE_CODE_REMOTE` | 远程模式标志 |

### 调试

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_DEBUG` | 启用调试日志 |
| `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` | 首帧后退出（性能测试） |
| `CLAUDE_CODE_EAGER_FLUSH` | 立即刷新会话存储 |

---

## 设置变更检测

```typescript
// utils/settings/changeDetector.ts
settingsChangeDetector.initialize()
// 监听设置文件变化（inotify/FSEvents）
// 变化时重新加载设置，触发 UI 更新
```

---

## 数据迁移（`src/migrations/`）

每次版本升级可能需要迁移配置：

```typescript
// 当前迁移版本：11
const CURRENT_MIGRATION_VERSION = 11

runMigrations()
  ├── migrateAutoUpdatesToSettings()
  ├── migrateBypassPermissionsAcceptedToSettings()
  ├── migrateSonnet1mToSonnet45()
  ├── migrateSonnet45ToSonnet46()
  ├── migrateOpusToOpus1m()
  └── ...（按版本顺序执行）
```

---

## 模型配置（`utils/model/`）

```typescript
// utils/model/model.ts
getDefaultMainLoopModel()     // 默认模型
getMainLoopModel()            // 当前生效模型
parseUserSpecifiedModel(str)  // 解析用户指定的模型字符串
normalizeModelStringForAPI(str) // 规范化为 API 格式

// utils/model/modelStrings.ts
ensureModelStringsInitialized()  // 初始化模型字符串映射

// utils/model/modelCapabilities.ts
refreshModelCapabilities()  // 刷新模型能力（context window 等）

// utils/model/deprecation.ts
getModelDeprecationWarning(model)  // 获取模型弃用警告
```

---

## 会话存储（`utils/sessionStorage.ts`）

```typescript
// 会话数据存储在 ~/.claude/sessions/
recordTranscript(messages)    // 持久化消息历史
loadTranscriptFromFile(path)  // 加载历史会话
getSessionIdFromLog(path)     // 从日志获取会话 ID
searchSessionsByCustomTitle(title)  // 按标题搜索会话
cacheSessionTitle(sessionId, title) // 缓存会话标题
```
