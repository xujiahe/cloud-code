# 启动性能优化

## 概述

Claude Code 对启动速度有极高要求，采用了多种技术将冷启动时间压缩到最低。

---

## 启动时间线

```
cli.tsx 加载（~0ms）
  │
  ├── 快速路径检测（--version 等）→ 0 模块加载
  │
  └── 正常路径
        │
        ├── startupProfiler.ts 初始化
        ├── startMdmRawRead()      // 并行：MDM 子进程
        ├── startKeychainPrefetch() // 并行：Keychain 读取
        │
        ├── 动态 import('../main.js')  // ~135ms 模块加载
        │
        └── main()
              ├── eagerLoadSettings()   // 提前加载配置
              ├── init()                // 认证、遥测初始化
              ├── getTools()            // 工具池初始化
              │
              ├── [交互模式] renderAndRun(<REPL />)  // 首帧渲染
              │     └── startDeferredPrefetches()    // 首帧后延迟预取
              │
              └── [无头模式] runHeadless()
```

---

## 关键优化技术

### 1. 快速路径（Fast Paths）

`cli.tsx` 在加载完整 CLI 之前检测特殊参数：

```typescript
// --version：零模块加载
if (args[0] === '--version') {
  console.log(`${MACRO.VERSION} (Claude Code)`)
  return  // 不加载任何模块
}

// bridge/daemon/bg 等：只加载必要模块
if (args[0] === 'remote-control') {
  const { bridgeMain } = await import('../bridge/bridgeMain.js')
  // 不加载 main.tsx 的 ~135ms 模块
}
```

### 2. 并行预取

启动时并行执行耗时操作：

```typescript
// 并行执行，不阻塞主流程
startMdmRawRead()       // MDM 配置读取（~50ms）
startKeychainPrefetch() // Keychain 读取（~65ms）
```

### 3. 延迟预取（Deferred Prefetches）

首帧渲染后才启动非关键预取：

```typescript
// startDeferredPrefetches() - 首帧后执行
void initUser()
void getUserContext()
void getRelevantTips()
void countFilesRoundedRg()
void initializeAnalyticsGates()
void refreshModelCapabilities()
void settingsChangeDetector.initialize()
```

### 4. 早期输入捕获

```typescript
// 用户在模块加载期间的输入被缓存
startCapturingEarlyInput()
// 模块加载完成后回放
seedEarlyInput(capturedInput)
```

### 5. 构建时死代码消除（DCE）

```typescript
// feature() 是 Bun bundle 宏，构建时求值
// false 分支在构建时被完全删除
const bridgeModule = feature('BRIDGE_MODE')
  ? require('./bridge/bridgeMain.js')
  : null  // 外部构建中此代码不存在
```

### 6. 懒加载（Lazy Require）

```typescript
// 避免循环依赖，同时延迟加载
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js')
// 只在首次调用时加载
```

### 7. 设置缓存（`utils/settings/settingsCache.ts`）

```typescript
// 设置文件解析结果缓存
// 避免重复读取和解析 JSON
resetSettingsCache()  // 设置变更时清除缓存
```

---

## 启动性能分析（`utils/startupProfiler.ts`）

```typescript
profileCheckpoint('main_tsx_entry')
profileCheckpoint('main_tsx_imports_loaded')
profileCheckpoint('eagerLoadSettings_start')
// ...

profileReport()  // 输出各阶段耗时
```

### 关键检查点

| 检查点 | 说明 |
|--------|------|
| `cli_entry` | CLI 入口 |
| `cli_before_main_import` | 开始加载 main.tsx |
| `cli_after_main_import` | main.tsx 加载完成 |
| `main_tsx_entry` | main.tsx 执行开始 |
| `main_tsx_imports_loaded` | 所有 import 完成 |
| `system_message_yielded` | 首个 SDK 消息输出 |

---

## --bare 模式优化

```typescript
// --bare 标志：最小化模式，跳过所有预取
if (isBareMode()) {
  return  // 跳过 startDeferredPrefetches
}

// 用于脚本化调用（-p 参数）
// 避免不必要的后台工作影响响应时间
```

---

## 无头模式性能（`utils/headlessProfiler.ts`）

```typescript
headlessProfilerCheckpoint('before_getSystemPrompt')
headlessProfilerCheckpoint('after_getSystemPrompt')
headlessProfilerCheckpoint('before_skills_plugins')
headlessProfilerCheckpoint('after_skills_plugins')
headlessProfilerCheckpoint('system_message_yielded')
// 追踪无头模式各阶段延迟
```

---

## Bun 运行时优化

Claude Code 使用 Bun 作为运行时：

- **更快的模块加载**：Bun 的 ESM 加载比 Node.js 快
- **内置工具**：ripgrep、bfs/ugrep 嵌入 Bun 二进制
- **Bundle 宏**：`feature()` 构建时求值，DCE 无用代码
- **单文件可执行**：`cli.js` 是打包后的单文件，减少 I/O

---

## 提示缓存（Prompt Cache）

```typescript
// 系统提示内容稳定时，Anthropic API 缓存提示
// 工具描述按名称排序（assembleToolPool 中的 sort）
// 保证相同工具集产生相同的提示前缀
// 缓存命中可节省 ~12x 输入 token 成本

// 设置文件路径使用内容哈希（非随机 UUID）
// 避免每次调用产生不同路径，破坏提示缓存
settingsPath = generateTempFilePath('claude-settings', '.json', {
  contentHash: trimmedSettings
})
```
