# MCP（Model Context Protocol）面试题图谱

> 覆盖 MCP 协议核心概念、工具调用、资源管理、传输层、安全模型与生产部署，适合 AI 工程师、全栈开发者面试备考。

---

## Q1. MCP 协议概述与架构

**难度：⭐⭐** | **高频标签：** `#协议设计` `#架构` `#AI工具链`

### 考察点

- MCP 解决的核心问题（工具调用标准化）
- Host / Client / Server 三层架构职责划分
- 传输层选型：stdio vs HTTP+SSE vs WebSocket
- 与 OpenAI Function Calling 的本质区别

### 参考答案

**MCP 解决什么问题？**

在 MCP 出现之前，每个 AI 应用都需要为每个外部工具（数据库、文件系统、API）编写专属的集成代码，形成 M×N 的集成矩阵。MCP 通过定义统一的协议规范，将其降为 M+N 的插件模型——AI Host 只需实现一次 MCP Client，工具提供方只需实现一次 MCP Server。

**三层架构：**

```
┌─────────────────────────────────────┐
│  Host（宿主应用）                    │
│  Claude Desktop / VS Code / IDE     │
│  ┌─────────────┐  ┌─────────────┐  │
│  │ MCP Client  │  │ MCP Client  │  │
│  └──────┬──────┘  └──────┬──────┘  │
└─────────┼────────────────┼─────────┘
          │ 传输层          │ 传输层
    ┌─────▼──────┐   ┌─────▼──────┐
    │ MCP Server │   │ MCP Server │
    │ (文件系统)  │   │ (数据库)   │
    └────────────┘   └────────────┘
```

- **Host**：持有 LLM 上下文，决策何时调用工具，管理多个 Client 实例
- **Client**：与单个 Server 保持 1:1 连接，负责协议握手、消息路由
- **Server**：暴露工具/资源/提示，无状态或有状态均可

**传输层对比：**

| 传输方式 | 适用场景 | 优点 | 缺点 |
|---------|---------|------|------|
| stdio | 本地子进程 | 零网络开销，天然隔离 | 仅限本地，无法跨机器 |
| HTTP+SSE | 远程服务，云部署 | 穿透防火墙，易于负载均衡 | 单向推送，需维护连接 |
| WebSocket | 高频双向通信 | 全双工，低延迟 | 连接管理复杂 |

**与 OpenAI Function Calling 的区别：**

| 维度 | OpenAI Function Calling | MCP |
|------|------------------------|-----|
| 标准化 | 厂商私有协议 | 开放协议（Anthropic 主导） |
| 工具发现 | 每次请求携带定义 | 运行时动态发现（tools/list） |
| 资源访问 | 不支持 | 原生支持 Resources |
| 传输层 | HTTP only | stdio / SSE / WebSocket |
| 状态管理 | 无状态 | 支持有状态会话 |

### 延伸思考

MCP 的设计哲学类似 LSP（Language Server Protocol）——通过标准化协议解耦工具生态。未来 MCP 可能成为 AI 工具调用的事实标准，就像 LSP 统一了编辑器插件生态一样。

---

## Q2. MCP 工具（Tools）的定义与调用流程

**难度：⭐⭐⭐** | **高频标签：** `#工具调用` `#JSON-Schema` `#类型安全`

### 考察点

- Tool 的 JSON Schema 定义规范与最佳实践
- tools/list → tools/call 完整调用链
- 参数校验与类型安全保障
- 错误处理的分层设计

### 参考答案

**调用链全流程：**

```
Client                    Server
  │                          │
  │── initialize ──────────► │  协议握手，交换能力
  │◄─ initialized ───────── │
  │                          │
  │── tools/list ──────────► │  发现可用工具
  │◄─ {tools: [...]} ─────── │
  │                          │
  │── tools/call ──────────► │  调用具体工具
  │   {name, arguments}      │
  │◄─ {content: [...]} ───── │  返回结构化结果
```

### 代码示例：完整 MCP Server 实现


```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ── 1. 定义工具的参数 Schema（用 Zod 做运行时校验）──────────────────────────

const SearchFilesSchema = z.object({
  directory: z.string().min(1).describe("要搜索的目录路径"),
  pattern: z.string().min(1).describe("文件名匹配模式，支持 glob"),
  maxResults: z.number().int().min(1).max(100).default(20).describe("最大返回数量"),
});

const ReadFileSchema = z.object({
  path: z.string().min(1).describe("文件绝对路径"),
  encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("读取编码"),
});

// ── 2. 工具注册表（集中管理，便于扩展）────────────────────────────────────────

const TOOLS = [
  {
    name: "search_files",
    description: "在指定目录中搜索匹配模式的文件",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "要搜索的目录路径" },
        pattern: { type: "string", description: "文件名匹配模式，支持 glob" },
        maxResults: { type: "number", description: "最大返回数量", default: 20 },
      },
      required: ["directory", "pattern"],
    },
  },
  {
    name: "read_file",
    description: "读取文件内容",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
      },
      required: ["path"],
    },
  },
] as const;

// ── 3. 工具执行器（每个工具独立函数，便于测试）────────────────────────────────

async function executeSearchFiles(args: z.infer<typeof SearchFilesSchema>) {
  const { glob } = await import("glob");
  const files = await glob(args.pattern, {
    cwd: args.directory,
    absolute: true,
    maxDepth: 5,
  });
  return files.slice(0, args.maxResults);
}

async function executeReadFile(args: z.infer<typeof ReadFileSchema>) {
  const fs = await import("fs/promises");
  // 安全检查：防止路径遍历攻击
  const path = await import("path");
  const resolved = path.resolve(args.path);
  if (!resolved.startsWith("/allowed/base/path")) {
    throw new McpError(ErrorCode.InvalidParams, `路径不在允许范围内: ${resolved}`);
  }
  const content = await fs.readFile(resolved, args.encoding as BufferEncoding);
  return content;
}

// ── 4. 创建 Server 实例 ────────────────────────────────────────────────────────

const server = new Server(
  { name: "filesystem-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── 5. 注册 tools/list 处理器 ─────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── 6. 注册 tools/call 处理器（含参数校验与错误分层）─────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_files": {
        // Zod 校验：失败时抛出 ZodError，统一转换为 McpError
        const validated = SearchFilesSchema.parse(args);
        const files = await executeSearchFiles(validated);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ files, count: files.length }, null, 2),
            },
          ],
        };
      }

      case "read_file": {
        const validated = ReadFileSchema.parse(args);
        const content = await executeReadFile(validated);
        return {
          content: [{ type: "text", text: content }],
        };
      }

      default:
        // 工具不存在：返回 MethodNotFound 错误
        throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error; // 已是 MCP 错误，直接抛出

    if (error instanceof z.ZodError) {
      // 参数校验失败：转换为 InvalidParams
      throw new McpError(
        ErrorCode.InvalidParams,
        `参数校验失败: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
      );
    }

    // 工具执行异常：包装为 InternalError（注意：这与工具返回错误不同）
    throw new McpError(
      ErrorCode.InternalError,
      `工具执行失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// ── 7. 启动 Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP Server 已启动（stdio 模式）");
```

### 延伸思考

工具的 JSON Schema 定义是 LLM 理解工具能力的唯一依据，`description` 字段的质量直接影响 LLM 的调用准确率。建议在 description 中包含：输入格式示例、边界条件说明、常见错误场景。

---

## Q3. MCP 资源（Resources）与提示（Prompts）

**难度：⭐⭐** | **高频标签：** `#资源管理` `#URI寻址` `#流式传输`

### 考察点

- Resources 的 URI 寻址规范与 MIME 类型声明
- resources/read 的流式传输实现
- Prompts 模板的参数化设计
- 文件系统资源服务器的完整实现

### 参考答案

**Resources vs Tools 的核心区别：**

- **Resources**：只读数据源，类似 REST GET，LLM 用于获取上下文
- **Tools**：可执行操作，有副作用，类似 REST POST/PUT/DELETE

**URI 寻址规范：**

```
file:///home/user/project/src/main.ts    # 本地文件
db://mydb/users/schema                   # 数据库 schema
git://repo/main/README.md                # Git 仓库内容
http://api.example.com/data/users        # 远程 API 数据
```

**MIME 类型最佳实践：**

- 文本内容：`text/plain`, `text/markdown`, `application/json`
- 二进制内容：`image/png`, `application/pdf`（需 base64 编码）
- 代码文件：`text/x-typescript`, `text/x-python`

### 代码示例：文件系统资源服务器


```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as mime from "mime-types";

const BASE_DIR = process.env.MCP_BASE_DIR ?? process.cwd();

// ── Resources 实现 ────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // 递归扫描目录，生成资源列表
  const files = await walkDir(BASE_DIR, { maxDepth: 3, maxFiles: 200 });

  return {
    resources: files.map((filePath) => ({
      uri: `file://${filePath}`,
      name: path.relative(BASE_DIR, filePath),
      description: `文件: ${path.basename(filePath)}`,
      mimeType: mime.lookup(filePath) || "application/octet-stream",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (!uri.startsWith("file://")) {
    throw new McpError(ErrorCode.InvalidParams, `不支持的 URI scheme: ${uri}`);
  }

  const filePath = uri.slice("file://".length);
  const resolved = path.resolve(filePath);

  // 安全检查：确保路径在允许目录内
  if (!resolved.startsWith(path.resolve(BASE_DIR))) {
    throw new McpError(ErrorCode.InvalidParams, "路径越界访问被拒绝");
  }

  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) {
    throw new McpError(ErrorCode.InvalidParams, `文件不存在: ${resolved}`);
  }

  const mimeType = mime.lookup(resolved) || "application/octet-stream";
  const isBinary = !mimeType.startsWith("text/") && mimeType !== "application/json";

  if (isBinary) {
    // 二进制文件：base64 编码
    const buffer = await fs.readFile(resolved);
    return {
      contents: [
        {
          uri,
          mimeType,
          blob: buffer.toString("base64"), // base64 编码的二进制内容
        },
      ],
    };
  }

  // 大文件流式读取（超过 1MB 分块返回）
  if (stat.size > 1024 * 1024) {
    const chunks: string[] = [];
    const stream = fs.createReadStream(resolved, { encoding: "utf-8" });
    for await (const chunk of stream) {
      chunks.push(chunk as string);
    }
    return {
      contents: [{ uri, mimeType, text: chunks.join("") }],
    };
  }

  const text = await fs.readFile(resolved, "utf-8");
  return {
    contents: [{ uri, mimeType, text }],
  };
});

// ── Prompts 实现 ──────────────────────────────────────────────────────────────

const PROMPT_TEMPLATES = {
  "code-review": {
    name: "code-review",
    description: "代码审查提示模板",
    arguments: [
      { name: "language", description: "编程语言", required: true },
      { name: "focus", description: "审查重点（性能/安全/可读性）", required: false },
    ],
  },
  "explain-file": {
    name: "explain-file",
    description: "解释文件内容的提示模板",
    arguments: [
      { name: "file_uri", description: "文件 URI", required: true },
      { name: "audience", description: "目标受众（初级/高级）", required: false },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.values(PROMPT_TEMPLATES),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const template = PROMPT_TEMPLATES[name as keyof typeof PROMPT_TEMPLATES];

  if (!template) {
    throw new McpError(ErrorCode.InvalidParams, `未知提示模板: ${name}`);
  }

  // 校验必填参数
  for (const arg of template.arguments) {
    if (arg.required && !args?.[arg.name]) {
      throw new McpError(ErrorCode.InvalidParams, `缺少必填参数: ${arg.name}`);
    }
  }

  if (name === "code-review") {
    const language = args?.language ?? "unknown";
    const focus = args?.focus ?? "整体质量";
    return {
      description: `${language} 代码审查`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请对以下 ${language} 代码进行审查，重点关注：${focus}。
请从以下维度分析：
1. 代码正确性与边界条件
2. 性能瓶颈与优化建议
3. 安全漏洞（注入、越界等）
4. 可读性与命名规范
5. 测试覆盖建议`,
          },
        },
      ],
    };
  }

  // explain-file 模板
  const fileUri = args?.file_uri ?? "";
  const audience = args?.audience ?? "高级";
  return {
    description: "文件解释",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `请解释 ${fileUri} 的内容，面向${audience}开发者，包含：架构设计、关键逻辑、依赖关系。`,
        },
      },
    ],
  };
});

// ── 工具函数 ──────────────────────────────────────────────────────────────────

async function walkDir(
  dir: string,
  opts: { maxDepth: number; maxFiles: number },
  depth = 0,
  results: string[] = []
): Promise<string[]> {
  if (depth > opts.maxDepth || results.length >= opts.maxFiles) return results;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= opts.maxFiles) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await walkDir(fullPath, opts, depth + 1, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
```

### 延伸思考

Resources 的 `resourcesChanged` 通知机制允许 Server 主动推送资源变更（如文件被修改），Client 可订阅后自动刷新上下文，这是 MCP 相比静态工具定义的重要优势。

---

## Q4. MCP 的传输层实现与连接管理

**难度：⭐⭐⭐** | **高频标签：** `#传输层` `#JSON-RPC` `#连接管理`

### 考察点

- stdio 传输的子进程生命周期管理
- HTTP+SSE 传输的连接保活与断线重连
- JSON-RPC 2.0 消息格式与序列化
- 生产环境的连接健壮性设计

### 参考答案

**JSON-RPC 2.0 消息格式：**

```json
// 请求
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "search", "arguments": {} } }

// 成功响应
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [...] } }

// 错误响应
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Invalid params" } }

// 通知（无 id，无需响应）
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
```

**stdio 传输特点：**
- 消息通过换行符分隔（NDJSON）
- stderr 用于日志，不参与协议通信
- 子进程退出即连接断开，需要监听 `exit` 事件

### 代码示例：带重连机制的 MCP Client


```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "events";

// ── 重连策略配置 ──────────────────────────────────────────────────────────────

interface RetryConfig {
  maxAttempts: number;       // 最大重试次数
  initialDelayMs: number;    // 初始延迟（指数退避基数）
  maxDelayMs: number;        // 最大延迟上限
  jitterMs: number;          // 随机抖动，避免惊群效应
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitterMs: 500,
};

// ── 带重连的 MCP Client 封装 ──────────────────────────────────────────────────

class ResilientMcpClient extends EventEmitter {
  private client: Client | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly serverUrl: string,
    private readonly retryConfig: RetryConfig = DEFAULT_RETRY
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.destroyed) throw new Error("Client 已销毁");
    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    try {
      this.client = new Client(
        { name: "resilient-client", version: "1.0.0" },
        { capabilities: {} }
      );

      // SSE 传输：适合远程服务器
      const transport = new SSEClientTransport(new URL(this.serverUrl));

      // 监听传输层断开事件
      transport.onclose = () => {
        this.connected = false;
        this.emit("disconnected");
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      };

      transport.onerror = (error) => {
        this.emit("error", error);
      };

      await this.client.connect(transport);
      this.connected = true;
      this.reconnectAttempts = 0; // 连接成功，重置计数
      this.emit("connected");
    } catch (error) {
      this.connected = false;
      this.emit("error", error);
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.retryConfig.maxAttempts) {
      this.emit("maxRetriesExceeded");
      return;
    }

    // 指数退避 + 随机抖动
    const delay = Math.min(
      this.retryConfig.initialDelayMs * Math.pow(2, this.reconnectAttempts),
      this.retryConfig.maxDelayMs
    ) + Math.random() * this.retryConfig.jitterMs;

    this.reconnectAttempts++;
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  // 带连接检查的工具调用
  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.connected || !this.client) {
      throw new Error("MCP Client 未连接，请等待重连");
    }
    return this.client.callTool({ name, arguments: args });
  }

  // 优雅关闭
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.client) {
      await this.client.close().catch(() => {}); // 忽略关闭错误
    }
    this.client = null;
    this.connected = false;
  }
}

// ── stdio 传输的子进程管理 ────────────────────────────────────────────────────

class StdioMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async connect(command: string, args: string[], env?: Record<string, string>) {
    this.transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    this.client = new Client(
      { name: "stdio-client", version: "1.0.0" },
      { capabilities: {} }
    );

    // 监听子进程异常退出
    this.transport.onclose = () => {
      console.error(`[MCP] 子进程已退出`);
    };

    await this.client.connect(this.transport);
  }

  async listTools() {
    if (!this.client) throw new Error("未连接");
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.client) throw new Error("未连接");
    return this.client.callTool({ name, arguments: args });
  }

  // 优雅关闭：先发送关闭信号，等待子进程退出
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.client) return;

    const closePromise = this.client.close();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("关闭超时")), timeoutMs)
    );

    await Promise.race([closePromise, timeoutPromise]).catch((err) => {
      console.error(`[MCP] 强制关闭子进程: ${err.message}`);
      // 强制终止子进程
      this.transport?.["_process"]?.kill("SIGKILL");
    });
  }
}

// ── 使用示例 ──────────────────────────────────────────────────────────────────

const client = new ResilientMcpClient("http://localhost:3000/sse");

client.on("connected", () => console.log("已连接"));
client.on("disconnected", () => console.log("连接断开，准备重连"));
client.on("reconnecting", ({ attempt, delayMs }) =>
  console.log(`第 ${attempt} 次重连，等待 ${delayMs.toFixed(0)}ms`)
);
client.on("maxRetriesExceeded", () => console.error("超过最大重试次数"));

await client.connect();
```

### 延伸思考

HTTP+SSE 传输中，SSE 连接是单向的（Server→Client），Client→Server 的消息通过独立的 HTTP POST 发送。这意味着需要维护两个连接，且 SSE 连接在某些代理/负载均衡器下可能被超时断开，需要配置适当的 keepalive 心跳。

---

## Q5. MCP 工具调用的异常处理与边界情况

**难度：⭐⭐⭐** | **高频标签：** `#异常处理` `#超时` `#幂等性`

### 考察点

- 工具执行超时的优雅处理
- 工具返回错误 vs 工具执行异常的语义区别
- 幂等性设计与重复调用防护
- 重试策略与退避算法

### 参考答案

**两种错误的本质区别：**

```
工具执行异常（Protocol Error）：
  → 工具本身崩溃、网络中断、参数非法
  → 以 JSON-RPC error 形式返回（isError 字段不存在）
  → Client 应视为调用失败，可重试

工具返回错误（Tool Error）：
  → 工具正常执行，但业务逻辑失败（文件不存在、权限不足）
  → 以 content 形式返回，isError: true
  → Client 不应重试（重试也会失败），应向用户报告
```

### 代码示例：带超时、重试、幂等键的工具调用封装


```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { randomUUID } from "crypto";

// ── 工具调用选项 ──────────────────────────────────────────────────────────────

interface ToolCallOptions {
  timeoutMs?: number;          // 超时时间（默认 30s）
  maxRetries?: number;         // 最大重试次数（默认 3）
  idempotencyKey?: string;     // 幂等键（防止重复执行）
  retryOn?: (error: Error) => boolean; // 自定义重试条件
}

// ── 幂等键存储（生产环境应使用 Redis）────────────────────────────────────────

const idempotencyStore = new Map<string, { result: unknown; expiresAt: number }>();

function getIdempotentResult(key: string): unknown | null {
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    idempotencyStore.delete(key);
    return null;
  }
  return entry.result;
}

function setIdempotentResult(key: string, result: unknown, ttlMs = 300_000) {
  idempotencyStore.set(key, { result, expiresAt: Date.now() + ttlMs });
}

// ── 带超时的 Promise 包装 ─────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ToolTimeoutError(`工具 "${toolName}" 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

// ── 自定义错误类型 ────────────────────────────────────────────────────────────

class ToolTimeoutError extends Error {
  readonly retryable = false; // 超时不重试（可能已产生副作用）
  constructor(message: string) {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

class ToolBusinessError extends Error {
  readonly retryable = false; // 业务错误不重试
  constructor(message: string, public readonly toolName: string) {
    super(message);
    this.name = "ToolBusinessError";
  }
}

class ToolNetworkError extends Error {
  readonly retryable = true; // 网络错误可重试
  constructor(message: string) {
    super(message);
    this.name = "ToolNetworkError";
  }
}

// ── 核心调用封装 ──────────────────────────────────────────────────────────────

async function callToolSafely(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  options: ToolCallOptions = {}
): Promise<unknown> {
  const {
    timeoutMs = 30_000,
    maxRetries = 3,
    idempotencyKey,
    retryOn = (err) => (err as any).retryable === true,
  } = options;

  // 1. 幂等性检查：相同 key 直接返回缓存结果
  if (idempotencyKey) {
    const cached = getIdempotentResult(idempotencyKey);
    if (cached !== null) {
      console.log(`[MCP] 幂等命中，跳过执行: ${idempotencyKey}`);
      return cached;
    }
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // 指数退避：1s, 2s, 4s...
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
      console.log(`[MCP] 第 ${attempt} 次重试: ${toolName}`);
    }

    try {
      const callPromise = client.callTool({ name: toolName, arguments: args });
      const result = await withTimeout(callPromise, timeoutMs, toolName);

      // 2. 检查工具是否返回业务错误（isError: true）
      if (result && typeof result === "object" && "isError" in result && result.isError) {
        const errorContent = (result as any).content?.[0]?.text ?? "未知工具错误";
        throw new ToolBusinessError(errorContent, toolName);
      }

      // 3. 成功：存储幂等结果
      if (idempotencyKey) {
        setIdempotentResult(idempotencyKey, result);
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // 不可重试的错误：立即抛出
      if (!retryOn(lastError)) {
        throw lastError;
      }

      // 已达最大重试次数
      if (attempt === maxRetries) {
        throw new Error(`工具 "${toolName}" 在 ${maxRetries} 次重试后仍失败: ${lastError.message}`);
      }
    }
  }

  throw lastError!;
}

// ── 使用示例 ──────────────────────────────────────────────────────────────────

// 带幂等键的文件写入（防止重复写入）
const result = await callToolSafely(
  client,
  "write_file",
  { path: "/tmp/output.txt", content: "Hello MCP" },
  {
    timeoutMs: 10_000,
    maxRetries: 0,                          // 写操作不重试
    idempotencyKey: `write-${randomUUID()}`, // 每次操作唯一 key
  }
);

// 带重试的只读查询
const searchResult = await callToolSafely(
  client,
  "search_files",
  { directory: "/home", pattern: "*.ts" },
  {
    timeoutMs: 5_000,
    maxRetries: 3,
    retryOn: (err) => err instanceof ToolNetworkError,
  }
);
```

### 延伸思考

幂等性设计的关键在于：**写操作必须幂等，读操作天然幂等**。对于 MCP 工具中的写操作（创建文件、发送邮件、扣款），应要求调用方传入幂等键，Server 端维护已执行记录，防止 LLM 因重试导致重复副作用。

---

## Q6. MCP 的安全模型与权限控制

**难度：⭐⭐⭐** | **高频标签：** `#安全` `#权限控制` `#注入防御`

### 考察点

- Human-in-the-loop 授权机制的实现
- 危险工具的沙箱隔离策略
- 输入参数的注入攻击防御（路径遍历、命令注入）
- 权限中间件的设计模式

### 参考答案

**MCP 安全威胁模型：**

1. **提示注入**：恶意内容通过工具参数注入，操控 LLM 行为
2. **路径遍历**：`../../etc/passwd` 访问越权文件
3. **命令注入**：`; rm -rf /` 注入 shell 命令
4. **权限提升**：低权限工具被用于访问高权限资源
5. **工具投毒**：恶意 MCP Server 伪装成合法工具

**Human-in-the-loop 设计原则：**

- 危险操作（删除、写入、网络请求）必须经用户确认
- 确认请求应展示完整参数，不能只显示工具名
- 超时未确认应默认拒绝，而非默认允许

### 代码示例：带权限检查的 MCP Server 中间件


```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";

// ── 权限级别定义 ──────────────────────────────────────────────────────────────

enum PermissionLevel {
  READ_ONLY = "read_only",       // 只读操作，无需确认
  WRITE = "write",               // 写操作，需要用户确认
  DANGEROUS = "dangerous",       // 危险操作（删除/执行），需要明确授权
  SYSTEM = "system",             // 系统级操作，默认禁止
}

// ── 工具权限注册表 ────────────────────────────────────────────────────────────

const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  read_file: PermissionLevel.READ_ONLY,
  search_files: PermissionLevel.READ_ONLY,
  write_file: PermissionLevel.WRITE,
  create_directory: PermissionLevel.WRITE,
  delete_file: PermissionLevel.DANGEROUS,
  execute_command: PermissionLevel.DANGEROUS,
  install_package: PermissionLevel.SYSTEM,
};

// ── 用户授权回调（由 Host 实现）──────────────────────────────────────────────

type AuthorizationCallback = (
  toolName: string,
  args: Record<string, unknown>,
  level: PermissionLevel
) => Promise<boolean>;

// ── 输入净化工具 ──────────────────────────────────────────────────────────────

class InputSanitizer {
  private readonly allowedBasePaths: string[];

  constructor(allowedPaths: string[]) {
    this.allowedBasePaths = allowedPaths.map((p) => path.resolve(p));
  }

  // 防止路径遍历攻击
  sanitizePath(inputPath: string): string {
    const resolved = path.resolve(inputPath);

    const isAllowed = this.allowedBasePaths.some((base) =>
      resolved.startsWith(base + path.sep) || resolved === base
    );

    if (!isAllowed) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `路径越界访问被拒绝: ${inputPath}（允许路径: ${this.allowedBasePaths.join(", ")}）`
      );
    }

    return resolved;
  }

  // 防止命令注入：白名单校验命令
  sanitizeCommand(command: string, allowedCommands: string[]): string {
    // 提取命令名（第一个词）
    const cmdName = command.split(/\s+/)[0];

    if (!allowedCommands.includes(cmdName)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `命令不在白名单中: ${cmdName}`
      );
    }

    // 检测常见注入模式
    const injectionPatterns = [
      /[;&|`$(){}[\]]/,  // shell 特殊字符
      /\.\.\//,           // 路径遍历
      /\/etc\/passwd/,    // 敏感文件
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(command)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `检测到潜在注入攻击: ${command}`
        );
      }
    }

    return command;
  }

  // 防止提示注入：净化字符串中的特殊指令
  sanitizeUserContent(content: string): string {
    // 移除可能的提示注入模式
    const dangerousPatterns = [
      /ignore previous instructions/gi,
      /system prompt/gi,
      /\[INST\]|\[\/INST\]/g,  // Llama 指令标记
      /<\|im_start\|>|<\|im_end\|>/g, // ChatML 标记
    ];

    let sanitized = content;
    for (const pattern of dangerousPatterns) {
      sanitized = sanitized.replace(pattern, "[FILTERED]");
    }
    return sanitized;
  }
}

// ── 权限中间件工厂 ────────────────────────────────────────────────────────────

function createPermissionMiddleware(
  server: Server,
  sanitizer: InputSanitizer,
  authorize: AuthorizationCallback
) {
  // 包装 tools/call 处理器
  const originalHandler = server["_requestHandlers"]?.get("tools/call");

  server.setRequestHandler(
    { method: "tools/call" } as any,
    async (request: any) => {
      const { name, arguments: args } = request.params;

      // 1. 获取工具权限级别
      const level = TOOL_PERMISSIONS[name] ?? PermissionLevel.DANGEROUS;

      // 2. 系统级操作：直接拒绝
      if (level === PermissionLevel.SYSTEM) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `工具 "${name}" 需要系统级权限，已被禁止`
        );
      }

      // 3. 危险/写操作：请求用户授权
      if (level === PermissionLevel.WRITE || level === PermissionLevel.DANGEROUS) {
        const approved = await authorize(name, args ?? {}, level);
        if (!approved) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `用户拒绝了工具 "${name}" 的执行请求`
          );
        }
      }

      // 4. 净化路径参数
      if (args && typeof args === "object") {
        const sanitizedArgs = { ...args } as Record<string, unknown>;
        for (const [key, value] of Object.entries(sanitizedArgs)) {
          if ((key === "path" || key === "directory" || key.endsWith("_path")) && typeof value === "string") {
            sanitizedArgs[key] = sanitizer.sanitizePath(value);
          }
          if (key === "content" && typeof value === "string") {
            sanitizedArgs[key] = sanitizer.sanitizeUserContent(value);
          }
        }
        request.params.arguments = sanitizedArgs;
      }

      // 5. 调用原始处理器
      return originalHandler?.(request);
    }
  );
}

// ── 使用示例 ──────────────────────────────────────────────────────────────────

const sanitizer = new InputSanitizer(["/home/user/projects", "/tmp/mcp-workspace"]);

createPermissionMiddleware(server, sanitizer, async (toolName, args, level) => {
  // 在实际应用中，这里会弹出 UI 对话框请求用户确认
  console.log(`\n⚠️  工具调用请求:`);
  console.log(`  工具: ${toolName} (${level})`);
  console.log(`  参数: ${JSON.stringify(args, null, 2)}`);

  // 模拟用户确认（生产环境应等待真实用户输入）
  return new Promise((resolve) => {
    process.stdout.write("是否允许？(y/n): ");
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim().toLowerCase() === "y");
    });
  });
});
```

### 延伸思考

MCP 的安全模型本质上是**最小权限原则**的实践：每个工具只应拥有完成其功能所需的最小权限。建议将高危工具（execute_command）部署在独立的沙箱容器中，通过 gVisor 或 Firecracker 实现内核级隔离，即使工具被攻击也无法影响宿主系统。

---

## Q7. MCP Server 的性能优化与生产部署

**难度：⭐⭐** | **高频标签：** `#性能优化` `#生产部署` `#并发控制`

### 考察点

- 工具调用的并发控制与背压机制
- 结果缓存策略（TTL、LRU、按参数哈希）
- 健康检查端点设计
- 优雅关闭与连接排空

### 参考答案

**生产部署关键指标：**

- **P99 延迟**：工具调用应在 5s 内完成，超时需有降级策略
- **并发限制**：防止单个 Client 耗尽 Server 资源
- **内存泄漏**：长连接场景下需监控内存增长
- **优雅重启**：部署新版本时不中断正在执行的工具调用

### 代码示例：生产级 MCP Server 框架


```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createHash } from "crypto";
import { LRUCache } from "lru-cache";

// ── 并发控制：信号量实现 ──────────────────────────────────────────────────────

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return () => this.release();
    }

    // 等待空闲槽位
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount() { return this.running; }
  get queuedCount() { return this.queue.length; }
}

// ── 结果缓存（LRU + TTL）─────────────────────────────────────────────────────

class ToolResultCache {
  private cache: LRUCache<string, { result: unknown; cachedAt: number }>;

  constructor(maxSize = 500, defaultTtlMs = 60_000) {
    this.cache = new LRUCache({
      max: maxSize,
      ttl: defaultTtlMs,
    });
  }

  // 基于工具名 + 参数哈希生成缓存键
  private buildKey(toolName: string, args: unknown): string {
    const hash = createHash("sha256")
      .update(toolName)
      .update(JSON.stringify(args))
      .digest("hex")
      .slice(0, 16);
    return `${toolName}:${hash}`;
  }

  get(toolName: string, args: unknown): unknown | null {
    const key = this.buildKey(toolName, args);
    const entry = this.cache.get(key);
    return entry?.result ?? null;
  }

  set(toolName: string, args: unknown, result: unknown): void {
    const key = this.buildKey(toolName, args);
    this.cache.set(key, { result, cachedAt: Date.now() });
  }

  invalidate(toolName: string): void {
    // 清除指定工具的所有缓存
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${toolName}:`)) {
        this.cache.delete(key);
      }
    }
  }
}

// ── 生产级 MCP Server ─────────────────────────────────────────────────────────

class ProductionMcpServer {
  private readonly app = express();
  private readonly semaphore = new Semaphore(10); // 最大 10 个并发工具调用
  private readonly cache = new ToolResultCache(500, 30_000);
  private readonly activeTransports = new Set<SSEServerTransport>();
  private isShuttingDown = false;

  // 不缓存的工具（有副作用）
  private readonly NON_CACHEABLE_TOOLS = new Set([
    "write_file", "delete_file", "execute_command", "send_email",
  ]);

  constructor(private readonly mcpServer: Server) {
    this.setupRoutes();
    this.setupGracefulShutdown();
  }

  private setupRoutes() {
    // 健康检查端点
    this.app.get("/health", (req, res) => {
      if (this.isShuttingDown) {
        return res.status(503).json({ status: "shutting_down" });
      }
      res.json({
        status: "healthy",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        concurrency: {
          active: this.semaphore.activeCount,
          queued: this.semaphore.queuedCount,
          max: 10,
        },
        connections: this.activeTransports.size,
      });
    });

    // 就绪检查（用于 Kubernetes readinessProbe）
    this.app.get("/ready", (req, res) => {
      if (this.isShuttingDown) {
        return res.status(503).json({ ready: false });
      }
      res.json({ ready: true });
    });

    // MCP SSE 端点
    this.app.get("/sse", async (req, res) => {
      if (this.isShuttingDown) {
        return res.status(503).send("Server is shutting down");
      }

      const transport = new SSEServerTransport("/message", res);
      this.activeTransports.add(transport);

      transport.onclose = () => {
        this.activeTransports.delete(transport);
      };

      await this.mcpServer.connect(transport);
    });

    // MCP 消息端点（Client→Server）
    this.app.post("/message", express.json(), async (req, res) => {
      // 找到对应的 transport 处理消息
      // 实际实现需要通过 session ID 路由
      res.status(200).send();
    });
  }

  // 带并发控制和缓存的工具调用包装
  async callToolWithGuards(
    toolName: string,
    args: Record<string, unknown>,
    handler: () => Promise<unknown>
  ): Promise<unknown> {
    // 1. 检查缓存（只读工具）
    if (!this.NON_CACHEABLE_TOOLS.has(toolName)) {
      const cached = this.cache.get(toolName, args);
      if (cached !== null) {
        return cached;
      }
    }

    // 2. 获取并发槽位（背压控制）
    const release = await this.semaphore.acquire();

    try {
      const result = await handler();

      // 3. 缓存结果（只读工具）
      if (!this.NON_CACHEABLE_TOOLS.has(toolName)) {
        this.cache.set(toolName, args, result);
      }

      return result;
    } finally {
      release(); // 确保释放槽位
    }
  }

  // 优雅关闭：等待所有进行中的调用完成
  private setupGracefulShutdown() {
    const shutdown = async (signal: string) => {
      console.log(`[MCP] 收到 ${signal}，开始优雅关闭...`);
      this.isShuttingDown = true;

      // 等待活跃连接完成（最多 30s）
      const deadline = Date.now() + 30_000;
      while (this.semaphore.activeCount > 0 && Date.now() < deadline) {
        console.log(`[MCP] 等待 ${this.semaphore.activeCount} 个进行中的调用完成...`);
        await new Promise((r) => setTimeout(r, 1000));
      }

      // 关闭所有 SSE 连接
      for (const transport of this.activeTransports) {
        await transport.close().catch(() => {});
      }

      console.log("[MCP] 优雅关闭完成");
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  listen(port: number) {
    return this.app.listen(port, () => {
      console.log(`[MCP] Server 已启动，监听端口 ${port}`);
    });
  }
}

// ── 启动示例 ──────────────────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: "production-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// 注册工具处理器...

const productionServer = new ProductionMcpServer(mcpServer);
productionServer.listen(parseInt(process.env.PORT ?? "3000"));
```

### 延伸思考

生产环境的 MCP Server 应当是无状态的（或状态外置到 Redis），这样才能水平扩展。对于 SSE 连接，需要使用粘性会话（sticky session）或通过共享存储（Redis Pub/Sub）实现跨实例的消息路由。

---

## 延伸阅读

1. [MCP 官方规范文档](https://spec.modelcontextprotocol.io/) — 协议完整规范，包含所有消息类型和错误码定义

2. [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — 官方 TypeScript 实现，含完整示例

3. [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) — Python 实现，适合数据科学工具集成

4. [Anthropic MCP 介绍博客](https://www.anthropic.com/news/model-context-protocol) — MCP 设计动机与生态愿景

5. [LSP 规范](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — MCP 设计参考，理解协议标准化的价值

6. [JSON-RPC 2.0 规范](https://www.jsonrpc.org/specification) — MCP 底层传输协议规范

7. [MCP Server 示例集合](https://github.com/modelcontextprotocol/servers) — 官方维护的参考实现（文件系统、数据库、浏览器等）

---

> 最后更新：2025 年 | 覆盖 MCP 协议 v1.x
