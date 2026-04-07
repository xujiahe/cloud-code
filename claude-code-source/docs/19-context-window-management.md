# 上下文窗口管理深度解析

## 一、上下文窗口的组成

```
API 请求的 token 分布（典型会话）：

┌─────────────────────────────────────────────────────────┐
│ 系统提示（System Prompt）                                  │
│  - 工具描述（~8K tokens）                                  │
│  - 权限说明（~2K tokens）                                  │
│  - 记忆系统提示 + MEMORY.md（~1-3K tokens）                │
│  - git status（~0.5K tokens）                             │
├─────────────────────────────────────────────────────────┤
│ 用户上下文（第一条 isMeta 消息）                             │
│  - CLAUDE.md 内容（0-40K tokens）                         │
│  - 当前日期                                               │
├─────────────────────────────────────────────────────────┤
│ 对话历史（Messages）                                       │
│  - 用户消息 + 附件（嵌套记忆、相关记忆等）                    │
│  - 助手响应（文本 + 工具调用）                               │
│  - 工具结果（文件内容、命令输出等）                           │
└─────────────────────────────────────────────────────────┘
```

---

## 二、Token 预算追踪（`query/tokenBudget.ts`）

```typescript
// 每轮 API 响应后更新 token 计数
tokenCountFromLastAPIResponse(messages)
    → 从最后一条 assistant 消息的 usage 字段读取

// 估算（当没有 API 响应时）
tokenCountWithEstimation(messages)
    → 基于字符数估算（~4 chars/token）

// 警告阈值
calculateTokenWarningState(tokenCount, model)
    → {
        isAtWarningLimit: boolean,   // 接近上限，显示警告
        isAtBlockingLimit: boolean,  // 达到上限，阻止新请求
      }
```

---

## 三、自动压缩（Auto Compact）

### 触发条件

```typescript
// services/compact/autoCompact.ts
isAutoCompactEnabled()
    → !isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)
    → !isEnvTruthy(process.env.DISABLE_COMPACT)

calculateTokenWarningState(tokenCount, model)
    → isAtBlockingLimit: tokenCount > contextWindow * 0.95
    → isAtWarningLimit: tokenCount > contextWindow * 0.85
```

### 压缩流程

```typescript
// query.ts 中的压缩逻辑
autocompact(messagesForQuery, toolUseContext, ...)
    │
    ├── 检查是否需要压缩（token 阈值）
    │
    ├── [需要压缩] buildPostCompactMessages(compactionResult)
    │     │
    │     ├── 调用 Claude 生成摘要
    │     │     → 系统提示：压缩指令
    │     │     → 用户消息：完整对话历史
    │     │     → 输出：结构化摘要
    │     │
    │     ├── 构建压缩后的消息列表：
    │     │     [compact_boundary 标记]
    │     │     [摘要消息]
    │     │     [保留的最近 N 条消息]
    │     │
    │     └── yield compact_boundary 消息（通知 SDK）
    │
    └── 继续使用压缩后的消息列表
```

### compact_boundary 消息

```typescript
// 压缩边界标记，用于会话恢复
{
  type: 'system',
  subtype: 'compact_boundary',
  compactMetadata: {
    preservedSegment: {
      tailUuid: string,  // 保留段最后一条消息的 UUID
      headUuid: string,  // 保留段第一条消息的 UUID
    },
    summaryUuid: string,  // 摘要消息的 UUID
  }
}

// 恢复时：
// 1. 找到 compact_boundary
// 2. 加载摘要消息
// 3. 加载 preservedSegment 中的消息
// 4. 跳过边界之前的历史消息
```

---

## 四、微压缩（Microcompact）

```typescript
// 比 autocompact 更轻量的压缩策略
// 针对单个工具结果进行压缩（而非整个对话）

// 触发条件：
// - 工具结果超过 maxResultSizeChars
// - 或工具结果总量超过预算

// 实现：
// services/compact/microCompact.ts
// 将大型工具结果替换为摘要 + 文件路径引用
```

---

## 五、工具结果预算（Tool Result Budget）

```typescript
// utils/toolResultStorage.ts
applyToolResultBudget(messages, contentReplacementState, ...)
    │
    ├── 计算所有工具结果的总大小
    │
    ├── 超出预算时：
    │     ├── 将大型工具结果持久化到磁盘
    │     │     → ~/.claude/tool-results/<uuid>.txt
    │     │
    │     └── 替换消息内容为：
    │           "Result too large. Saved to: <path>
    │            Preview: <first 500 chars>..."
    │
    └── 记录替换状态（contentReplacementState）
          → 用于子 Agent 共享缓存
```

---

## 六、历史片段压缩（Snip）

```typescript
// HISTORY_SNIP 功能开关
// services/compact/snipCompact.ts

// 比 autocompact 更精细：
// - 只压缩特定的历史片段
// - 保留最近的完整上下文
// - 用于长会话中的中间历史

snipCompactIfNeeded(messages)
    → {
        messages: Message[],      // 压缩后的消息
        tokensFreed: number,      // 释放的 token 数
        boundaryMessage?: Message // 压缩边界消息
      }
```

---

## 七、上下文折叠（Context Collapse）

```typescript
// CONTEXT_COLLAPSE 功能开关
// services/contextCollapse/

// 更激进的压缩策略：
// - 将多个工具调用折叠为单行摘要
// - 保留语义信息，大幅减少 token 数
// - 用于超长会话

applyCollapsesIfNeeded(messages, toolUseContext, querySource)
    → { messages: Message[] }  // 折叠后的消息
```

---

## 八、上下文窗口的动态调整

### 模型切换时的上下文窗口

```typescript
// 不同模型有不同的上下文窗口大小
getContextWindowForModel(model, sdkBetas)
    → 200K（claude-3-5-sonnet）
    → 1M（claude-3-5-sonnet-1m，需要 beta）
    → 200K（claude-opus-4-5）

// 计划模式下的特殊处理：
// 当最近的助手消息超过 200K token 时，切换到更大上下文的模型
getRuntimeMainLoopModel({
  permissionMode: 'plan',
  exceeds200kTokens: true,
  // → 自动切换到支持更大上下文的模型
})
```

### Token 预算续期（+500K）

```typescript
// query/tokenBudget.ts
// 当接近上限时，尝试扩展 token 预算

createBudgetTracker()
checkTokenBudget(tracker, messages, model)
    → 如果接近上限，触发 budget continuation
    → 在下一轮请求中增加 max_tokens
    → 最多续期 N 次（incrementBudgetContinuationCount）
```

---

## 九、附件系统与上下文注入

### 附件类型与 token 成本

```typescript
// 高 token 成本附件（需要控制数量）：
// - file：完整文件内容（可达数万 token）
// - relevant_memories：每个最多 4KB
// - nested_memory：CLAUDE.md 内容
// - skill_listing：Skill 列表

// 低 token 成本附件：
// - todo_reminder：TODO 列表摘要
// - plan_mode：计划模式提醒
// - date_change：日期变更通知
// - deferred_tools_delta：工具列表变更
```

### 附件的 system-reminder 包装

```typescript
// 大多数附件被包装在 <system-reminder> 标签中
// 这告诉模型这是系统注入的上下文，不是用户输入

wrapMessagesInSystemReminder(messages)
    → `<system-reminder>
       ${attachmentContent}
       </system-reminder>`

// 模型被指示：
// "这些上下文可能与你的任务相关，也可能不相关
//  除非高度相关，否则不要回应这些上下文"
```

---

## 十、上下文管理的完整流程

```
每次 API 调用前的上下文准备：

query.ts::queryLoop()
    │
    ├── 1. applyToolResultBudget()
    │         → 大型工具结果持久化到磁盘
    │
    ├── 2. snipCompactIfNeeded()  [HISTORY_SNIP]
    │         → 压缩中间历史片段
    │
    ├── 3. microcompact()
    │         → 压缩重复的工具调用
    │
    ├── 4. applyCollapsesIfNeeded()  [CONTEXT_COLLAPSE]
    │         → 折叠工具调用为摘要
    │
    ├── 5. autocompact()
    │         → 整体对话压缩（最后手段）
    │
    ├── 6. 检查 isAtBlockingLimit
    │         → 如果仍然超限，返回错误消息
    │
    ├── 7. normalizeMessagesForAPI()
    │         → 过滤 isMeta 消息（不发给 API）
    │         → 规范化工具调用格式
    │         → 确保 tool_use/tool_result 配对
    │
    ├── 8. prependUserContext()
    │         → 注入 CLAUDE.md + 日期
    │
    ├── 9. buildSystemPromptBlocks()
    │         → 分割系统提示为多个块
    │         → 添加 cache_control 标记
    │
    └── 10. API 调用
              → 系统提示（带缓存控制）
              → 消息历史（规范化后）
              → 工具列表（带 defer_loading）
```

---

## 十一、记忆与上下文的交互关系

```
会话开始
    │
    ├── 系统提示注入 MEMORY.md 内容（静态，会话级缓存）
    ├── 用户上下文注入 CLAUDE.md 内容（静态，会话级缓存）
    │
    ▼
每轮对话
    │
    ├── 相关记忆预取（异步，与 API 并行）
    │     → 5 个最相关的记忆文件作为附件注入
    │
    ├── 嵌套记忆（按需）
    │     → 模型访问某目录时，加载该目录的 CLAUDE.md
    │
    ├── 动态 Skill 发现（按需）
    │     → 模型访问匹配 paths 的文件时，激活条件 Skill
    │
    └── 对话结束
          │
          ├── extractMemories（后台）
          │     → 提取本轮对话中值得保存的记忆
          │     → 写入 memory/ 目录
          │
          └── autoDream（定期）
                → 整合多个会话的记忆
                → 更新 MEMORY.md 索引
```
