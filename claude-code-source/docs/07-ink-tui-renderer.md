# Ink TUI 渲染器（`src/ink/`）

## 概述

Claude Code 使用自定义的 Ink 渲染引擎，将 React 组件树渲染到终端。这是对原版 `ink` 库的深度定制版本，针对 Claude Code 的需求做了大量优化。

---

## 架构

```
React 组件树
    │
    ▼
ink/reconciler.ts    // React 自定义渲染器（Fiber reconciler）
    │
    ▼
ink/dom.ts           // 虚拟 DOM（Yoga 布局节点）
    │
    ▼
ink/renderer.ts      // 布局计算 + 输出生成
    │
    ├── yoga-layout  // Flexbox 布局引擎（native-ts/yoga-layout/）
    ├── render-node-to-output.ts  // 节点 → 字符串
    └── render-to-screen.ts      // 差量更新到终端
    │
    ▼
ink/output.ts        // 终端输出缓冲
    │
    ▼
ink/log-update.ts    // 终端原地更新（覆写上一帧）
```

---

## 核心文件

| 文件 | 职责 |
|------|------|
| `ink.tsx` | 主入口，`render()` 函数 |
| `reconciler.ts` | React Fiber 自定义渲染器 |
| `dom.ts` | 虚拟 DOM 节点类型 |
| `renderer.ts` | 布局计算与渲染协调 |
| `render-node-to-output.ts` | 节点转字符串输出 |
| `render-to-screen.ts` | 差量更新终端 |
| `output.ts` | 输出缓冲区 |
| `frame.ts` | 帧管理（动画） |
| `screen.ts` | 终端屏幕状态 |
| `styles.ts` | 样式系统（颜色、边框等） |
| `terminal.ts` | 终端能力检测 |
| `parse-keypress.ts` | 键盘输入解析 |
| `focus.ts` | 焦点管理 |
| `selection.ts` | 文本选择 |
| `optimizer.ts` | 渲染优化（跳过未变化节点） |
| `measure-text.ts` | 文本宽度测量（Unicode 支持） |
| `wrap-text.ts` | 文本换行 |
| `bidi.ts` | 双向文本（RTL）支持 |
| `searchHighlight.ts` | 搜索高亮 |
| `tabstops.ts` | Tab 键停止点 |
| `hit-test.ts` | 鼠标点击测试 |

---

## 渲染流程

```
setState() / props 变化
    │
    ▼
React reconciler 调度更新
    │
    ▼
renderer.ts::render()
    │
    ├── 遍历 DOM 树，计算 Yoga 布局
    ├── render-node-to-output.ts：节点 → Output 对象
    │     ├── 处理文本、颜色、边框
    │     ├── 处理 ANSI 转义序列
    │     └── 处理 Unicode 宽字符
    │
    ├── optimizer.ts：跳过未变化区域
    │
    └── render-to-screen.ts：差量写入终端
          ├── 计算需要更新的行
          ├── 生成 ANSI 移动光标序列
          └── 写入 stdout
```

---

## 终端 I/O（`ink/termio/`）

```typescript
// termio/dec.ts - DEC 终端控制序列
SHOW_CURSOR / HIDE_CURSOR
ENABLE_MOUSE / DISABLE_MOUSE
ENTER_ALT_SCREEN / EXIT_ALT_SCREEN

// termio/ansi.ts - ANSI 颜色/样式
// termio/csi.ts - CSI 控制序列
```

---

## 键盘处理

```typescript
// parse-keypress.ts
// 将原始字节序列解析为键盘事件
type KeyboardEvent = {
  key: string        // 'return', 'escape', 'up', 'ctrl+c' 等
  ctrl: boolean
  meta: boolean
  shift: boolean
  // ...
}
```

---

## 性能优化

### 差量渲染

`render-to-screen.ts` 只更新变化的行，避免全屏重绘。

### 节点缓存

`node-cache.ts` 缓存已计算的节点，避免重复布局。

### 行宽缓存

`line-width-cache.ts` 缓存文本宽度计算结果（Unicode 宽字符计算较慢）。

### 虚拟滚动

`components/VirtualMessageList.tsx` 只渲染可见区域的消息，处理长对话历史。

---

## 自定义组件（`ink/components/`）

```
ink/components/
├── Box.tsx          // Flexbox 容器
├── Text.tsx         // 文本节点（颜色、样式）
├── Newline.tsx      // 换行
├── Spacer.tsx       // 弹性空间
└── Static.tsx       // 静态内容（不参与差量更新）
```

---

## 与标准 Ink 的差异

1. **自定义 Yoga 绑定**：`native-ts/yoga-layout/` 提供 TypeScript 原生绑定
2. **双向文本支持**：`bidi.ts` 处理阿拉伯语/希伯来语等 RTL 文本
3. **鼠标支持**：`hit-test.ts` 实现点击测试
4. **搜索高亮**：`searchHighlight.ts` 在渲染层实现文本高亮
5. **FPS 追踪**：`context/fpsMetrics.tsx` 监控渲染性能
6. **OffscreenFreeze**：`components/OffscreenFreeze.tsx` 冻结屏幕外内容
