# 会话与记忆管理

## 会话管理（`utils/sessionStorage.ts`）

### 会话存储结构

```
~/.claude/
├── sessions/
│   ├── <session-id>.jsonl    # 会话 transcript（JSONL 格式）
│   └── ...
├── tasks/
│   └── <task-id>.txt         # 任务输出文件
└── config.json               # 全局配置
```

### 核心操作

```typescript
recordTranscript(messages)
  // 将消息追加写入 JSONL 文件
  // 使用写入队列（bufferedWriter）避免并发冲突
  // 100ms 懒写入（批量合并）

loadTranscriptFromFile(path)
  // 读取并解析 JSONL 文件
  // 支持 compact_boundary 恢复

getSessionIdFromLog(path)
  // 从 transcript 文件提取会话 ID

searchSessionsByCustomTitle(title)
  // 按自定义标题搜索历史会话

cacheSessionTitle(sessionId, title)
  // 缓存会话标题（用于 /resume 列表显示）
```

### 会话恢复（`utils/sessionRestore.ts`）

```typescript
// --resume 参数触发
processResumedConversation(sessionId)
  │
  ├── 加载 transcript 文件
  ├── 处理 compact_boundary（恢复压缩后的历史）
  ├── 重建消息历史
  └── 返回 ProcessedResume 对象
```

### 会话 ID

```typescript
// 格式：UUID v4
// 存储在 bootstrap/state.ts 的全局状态
getSessionId()   // 获取当前会话 ID
switchSession()  // 切换到新会话
```

---

## 记忆系统（`src/memdir/`）

### CLAUDE.md 文件层级

```
~/.claude/CLAUDE.md              # 全局记忆（所有项目共享）
<project>/.claude/CLAUDE.md      # 项目记忆
<project>/src/.claude/CLAUDE.md  # 子目录记忆（嵌套记忆）
```

### 记忆加载

```typescript
// memdir/memdir.ts
loadMemoryPrompt()
  // 扫描当前目录及父目录的 CLAUDE.md
  // 合并为单一记忆提示
  // 注入到系统提示中

// 嵌套记忆（nested_memory）
// 当 Claude 读取某目录时，自动加载该目录的 CLAUDE.md
// 通过 nestedMemoryAttachmentTriggers 追踪已加载路径
```

### 记忆扫描（`memdir/memoryScan.ts`）

```typescript
scanForMemories(dir)
  // 递归扫描目录中的 CLAUDE.md 文件
  // 返回记忆文件列表和内容
```

### 相关记忆查找（`memdir/findRelevantMemories.ts`）

```typescript
findRelevantMemories(query, memories)
  // 基于语义相似度找到最相关的记忆片段
  // 用于记忆文件过大时的选择性加载
```

### 记忆类型（`memdir/memoryTypes.ts`）

```typescript
type MemoryType =
  | 'global'    // ~/.claude/CLAUDE.md
  | 'project'   // <project>/.claude/CLAUDE.md
  | 'nested'    // 子目录 CLAUDE.md
  | 'team'      // 团队共享记忆
```

### 团队记忆（`memdir/teamMemPaths.ts`、`memdir/teamMemPrompts.ts`）

```typescript
// 团队共享记忆路径
// 多个 Agent 共享同一记忆文件
// 通过 teamMemorySync 服务同步
```

---

## 文件历史（`utils/fileHistory.ts`）

```typescript
// 追踪 Claude 修改的文件
// 每次用户消息前做快照
// 支持 /rewind 回滚到之前状态

type FileHistorySnapshot = {
  uuid: string          // 对应的用户消息 UUID
  files: Map<string, string>  // 文件路径 → 内容快照
  timestamp: number
}

fileHistoryEnabled()           // 是否启用文件历史
fileHistoryMakeSnapshot(...)   // 创建快照
```

---

## 上下文压缩（Compact）

### 自动压缩触发

```typescript
// query/tokenBudget.ts
// 监控 token 用量
// 接近 context window 时触发压缩

type TokenBudgetState = {
  inputTokens: number
  outputTokens: number
  contextWindow: number
  warningThreshold: number  // 触发警告的阈值
  compactThreshold: number  // 触发压缩的阈值
}
```

### 压缩流程

```typescript
// services/compact/
// 1. 选择要压缩的消息范围
// 2. 调用 Claude 生成摘要
// 3. 替换历史消息为摘要
// 4. 插入 compact_boundary 标记
// 5. 保留最近 N 条消息（preservedSegment）
```

### compact_boundary 消息

```typescript
type CompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  compactMetadata: {
    preservedSegment?: {
      tailUuid: string    // 保留段的最后一条消息 UUID
      headUuid: string    // 保留段的第一条消息 UUID
    }
    summaryUuid: string   // 摘要消息的 UUID
  }
}
```

---

## 历史片段压缩（Snip）

```typescript
// services/compact/snipCompact.ts（HISTORY_SNIP 功能）
// 更精细的历史压缩策略
// 只压缩特定片段，保留关键上下文

// services/compact/snipProjection.ts
// 在 REPL 中投影压缩后的视图
// 用户看到完整历史，API 只发送压缩版本
```

---

## 会话并发（`utils/concurrentSessions.ts`）

```typescript
// 追踪同时运行的 Claude Code 实例
countConcurrentSessions()   // 当前并发会话数
registerSession(sessionId)  // 注册新会话
updateSessionName(sessionId, name)  // 更新会话名称
```

---

## 会话恢复（Teleport Resume）

```typescript
// utils/teleport.ts
// 从远程会话恢复本地执行
processMessagesForTeleportResume(messages)
  // 处理远程会话的消息历史
  // 恢复到本地可继续执行的状态

checkOutTeleportedSessionBranch(sessionId)
  // 检出远程会话对应的 git 分支
```
