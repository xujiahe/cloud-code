# Vite 与前端工程化面试题

---

## Vite 基础

### Q1：Vite 为什么比 Webpack 快？

开发环境：
- Webpack 启动时需要打包所有模块，项目越大越慢
- Vite 利用浏览器原生 ESM，按需加载，启动时只处理入口文件，模块在请求时才编译

生产环境：
- Vite 用 Rollup 打包，Rollup 对 ESM tree-shaking 更彻底
- 依赖预构建（esbuild）：将 node_modules 中的 CJS/UMD 转为 ESM，esbuild 用 Go 编写，比 JS 快 10-100 倍

```
Webpack 开发启动：打包所有 → 启动服务
Vite 开发启动：启动服务 → 按需编译（请求时）
```

---

### Q2：Vite 的依赖预构建是什么？为什么需要？

Vite 启动时会对 `node_modules` 中的依赖做预构建，缓存到 `node_modules/.vite`。

原因：
1. 兼容性：很多包是 CJS 格式，浏览器不支持，需要转为 ESM
2. 性能：有些包（如 lodash-es）有几百个模块，浏览器发几百个请求会很慢，预构建合并为一个文件

触发重新预构建：
- 修改 `vite.config.js` 中的 `optimizeDeps`
- 手动删除 `node_modules/.vite`
- 运行 `vite --force`

---

### Q3：Vite 的热更新（HMR）原理？

1. Vite 启动时建立 WebSocket 连接（客户端与开发服务器）
2. 文件变化时，Vite 分析模块依赖图，找到受影响的模块边界
3. 通过 WebSocket 推送更新消息给客户端
4. 客户端动态 `import` 新模块，替换旧模块

```javascript
// 模块可以声明自己的 HMR 处理逻辑
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    // 用新模块替换旧模块
  });

  import.meta.hot.dispose(() => {
    // 清理副作用（定时器、事件监听等）
  });
}
```

Vue/React 的组件 HMR 由对应插件（@vitejs/plugin-vue）处理，保留组件状态。

---

## 配置

### Q4：`vite.config.ts` 常用配置有哪些？

```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'), // @ 指向 src
    },
  },

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // 手动分包
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          utils: ['lodash-es', 'dayjs'],
        },
      },
    },
  },

  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables" as *;`, // 全局注入变量
      },
    },
  },
});
```

---

### Q5：如何在 Vite 中配置环境变量？

Vite 使用 `.env` 文件管理环境变量，只有 `VITE_` 前缀的变量会暴露给客户端。

```bash
# .env（所有环境）
VITE_APP_TITLE=My App

# .env.development（开发环境）
VITE_API_URL=http://localhost:8080

# .env.production（生产环境）
VITE_API_URL=https://api.example.com
```

```typescript
// 使用
const apiUrl = import.meta.env.VITE_API_URL;
const isDev = import.meta.env.DEV;   // boolean
const isProd = import.meta.env.PROD; // boolean
const mode = import.meta.env.MODE;   // 'development' | 'production'
```

TypeScript 类型提示：
```typescript
// env.d.ts
interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_APP_TITLE: string;
}
```

---

## 插件

### Q6：Vite 插件的基本结构？常用钩子有哪些？

Vite 插件基于 Rollup 插件接口扩展，返回一个对象：

```typescript
import type { Plugin } from 'vite';

function myPlugin(): Plugin {
  return {
    name: 'my-plugin', // 必填，用于错误提示

    // 构建钩子（Rollup 兼容）
    resolveId(id) {
      if (id === 'virtual:my-module') return id; // 处理虚拟模块
    },
    load(id) {
      if (id === 'virtual:my-module') {
        return `export const msg = 'hello from virtual module'`;
      }
    },
    transform(code, id) {
      // 转换代码，类似 webpack loader
      if (id.endsWith('.vue')) { /* ... */ }
      return code;
    },

    // Vite 特有钩子
    configureServer(server) {
      // 配置开发服务器，添加自定义中间件
      server.middlewares.use('/custom', (req, res) => {
        res.end('custom response');
      });
    },
    handleHotUpdate({ file, server }) {
      // 自定义 HMR 处理
      if (file.endsWith('.md')) {
        server.ws.send({ type: 'full-reload' });
      }
    },
  };
}
```

---

## 构建优化

### Q7：如何分析和优化 Vite 打包体积？

```bash
# 安装分析插件
npm i -D rollup-plugin-visualizer
```

```typescript
// vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    visualizer({ open: true, gzipSize: true }), // 构建后自动打开分析报告
  ],
});
```

常见优化手段：

```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        // 将 node_modules 按包名分割
        if (id.includes('node_modules')) {
          const pkg = id.split('node_modules/')[1].split('/')[0];
          // 大包单独分割
          if (['echarts', 'monaco-editor'].includes(pkg)) return pkg;
          return 'vendor';
        }
      },
    },
  },
  // 启用 CSS 代码分割
  cssCodeSplit: true,
  // 小于此大小的资源内联为 base64
  assetsInlineLimit: 4096,
}
```

---

### Q8：Vite 生产构建和开发环境的差异？如何保持一致？

| | 开发环境 | 生产环境 |
|--|---------|---------|
| 打包工具 | esbuild（按需） | Rollup |
| 模块格式 | 原生 ESM | 打包后的 IIFE/ESM |
| Source Map | 完整 | 可选 |
| 代码压缩 | 否 | 是（esbuild/terser） |

常见不一致问题：
- 开发用 `import.meta.glob` 动态导入，生产打包行为不同
- CSS 模块在开发/生产的类名生成规则不同
- 环境变量在开发/生产的值不同

建议：定期运行 `vite build && vite preview` 验证生产构建。

---

## 工程化通用

### Q9：monorepo 是什么？pnpm workspace 如何配置？

monorepo 是将多个相关项目放在同一个仓库中管理，共享依赖、工具链和 CI 配置。

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

```
my-monorepo/
├── packages/
│   ├── ui/          # 组件库
│   └── utils/       # 工具函数
├── apps/
│   ├── web/         # 主应用
│   └── admin/       # 管理后台
└── pnpm-workspace.yaml
```

```bash
# 在根目录安装所有依赖
pnpm install

# 给特定包安装依赖
pnpm --filter web add axios

# 引用内部包（package.json）
{ "dependencies": { "@my/ui": "workspace:*" } }
```

---

### Q10：前端 CI/CD 流程一般包含哪些步骤？

```yaml
# .github/workflows/deploy.yml 示例
name: Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install pnpm
        uses: pnpm/action-setup@v2

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm tsc --noEmit

      - name: Lint
        run: pnpm eslint src

      - name: Test
        run: pnpm vitest --run

      - name: Build
        run: pnpm build
        env:
          VITE_API_URL: ${{ secrets.API_URL }}

      - name: Deploy
        run: # 上传 dist 到 CDN 或服务器
```

---

### Q11：如何配置 ESLint + Prettier + husky 保证代码质量？

```bash
# 安装
npm i -D eslint prettier eslint-config-prettier
npm i -D husky lint-staged
```

```javascript
// eslint.config.js（ESLint v9 flat config）
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';

export default [
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  { rules: { 'no-console': 'warn' } },
];
```

```json
// package.json
{
  "lint-staged": {
    "*.{ts,vue}": ["eslint --fix", "prettier --write"],
    "*.{css,scss}": ["prettier --write"]
  }
}
```

```bash
# 初始化 husky
npx husky init
echo "npx lint-staged" > .husky/pre-commit
```

提交前自动 lint + format，不符合规范的代码无法提交。

---

### Q12：`package.json` 中 `dependencies`、`devDependencies`、`peerDependencies` 的区别？

- `dependencies`：运行时依赖，打包时会包含（如 vue、axios）
- `devDependencies`：开发时依赖，不会进入生产包（如 vite、eslint、typescript）
- `peerDependencies`：声明宿主环境需要提供的依赖，常用于插件/库开发

```json
// 开发一个 Vue 组件库时
{
  "peerDependencies": {
    "vue": "^3.0.0"  // 告诉使用方：你需要自己安装 Vue 3
  },
  "devDependencies": {
    "vue": "^3.4.0"  // 开发时用的 Vue 版本
  }
}
```

peerDependencies 的作用：避免同一个包被安装多次（如两份 Vue 实例会导致响应式失效）。
