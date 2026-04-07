# Canvas 与表格绘制前端面试题图谱 — 总索引

> 本图谱系统覆盖 Canvas API 基础、表格绘制技术、性能优化策略、实战应用五大维度，共 5 个专题文档，适合初级到高级前端开发者备战面试使用。

---

## 文档导航

| 文档名 | 难度范围 | 核心知识点 | 链接 |
|--------|----------|-----------|------|
| 01-canvas-basics.md | ⭐~⭐⭐ | Canvas 元素初始化、坐标系、路径绘制（moveTo/lineTo/arc/bezierCurveTo）、填充与描边、样式设置（颜色/渐变/阴影） | [Canvas 基础](./01-canvas-basics.md) |
| 02-canvas-advanced.md | ⭐⭐~⭐⭐⭐ | 变换矩阵（translate/rotate/scale/transform）、图像处理（drawImage/getImageData/putImageData）、OffscreenCanvas 与 Web Worker、状态管理（save/restore）与裁剪（clip） | [Canvas 进阶](./02-canvas-advanced.md) |
| 03-table-rendering.md | ⭐⭐~⭐⭐⭐ | DOM 表格 vs Canvas 表格方案对比、固定表头与冻结列、虚拟滚动原理、单元格合并坐标计算、文字溢出省略与自动换行 | [表格绘制专题](./03-table-rendering.md) |
| 04-performance.md | ⭐⭐~⭐⭐⭐ | 分层渲染（多 Canvas 叠加）、脏矩形局部重绘、requestAnimationFrame 帧率控制、devicePixelRatio 高清屏适配、大数据量内存管理 | [性能优化专题](./04-performance.md) |
| 05-practical-cases.md | ⭐⭐⭐ | 拖拽调整列宽、ECharts 底层渲染原理、Canvas vs SVG 选型对比、Canvas 事件系统（鼠标命中检测）、低代码平台拖拽画布 | [实战应用专题](./05-practical-cases.md) |

---

## 学习路径建议

### 初级路径（0~1 年经验）

适合刚接触 Canvas 或准备初级前端岗位面试的开发者。

1. **[Canvas 基础](./01-canvas-basics.md)** — 从 Canvas 元素初始化开始，掌握路径绘制、填充描边、样式设置等核心 API
2. **[表格绘制专题](./03-table-rendering.md)** — 了解 DOM 表格与 Canvas 表格的基本区别，掌握简单表格绘制思路

建议学习时间：3~5 天

---

### 中级路径（1~3 年经验）

适合有一定 Canvas 基础、准备中级前端岗位面试的开发者。

1. **[Canvas 基础](./01-canvas-basics.md)** — 快速复习，重点关注 ⭐⭐ 难度题目
2. **[Canvas 进阶](./02-canvas-advanced.md)** — 深入变换矩阵、图像处理、OffscreenCanvas 等进阶特性
3. **[表格绘制专题](./03-table-rendering.md)** — 掌握虚拟滚动、冻结列、单元格合并等复杂场景
4. **[性能优化专题](./04-performance.md)** — 了解分层渲染、脏矩形等优化策略

建议学习时间：7~10 天

---

### 高级路径（3 年以上经验）

适合准备高级/资深前端岗位面试，或需要深度掌握 Canvas 技术的开发者。

1. **[Canvas 进阶](./02-canvas-advanced.md)** — 重点掌握 OffscreenCanvas + Web Worker 方案及兼容性处理
2. **[性能优化专题](./04-performance.md)** — 深入理解脏矩形、GC 压力控制、高清屏适配等高阶优化
3. **[实战应用专题](./05-practical-cases.md)** — 结合真实业务场景，掌握拖拽调列宽、事件系统、低代码平台等实战题
4. **[表格绘制专题](./03-table-rendering.md)** — 补充复杂表格场景的坐标计算与渲染细节

建议学习时间：5~7 天（侧重深度）

---

## 高频考点速查

### 🔥 字节跳动高频

| 考点 | 难度 | 所在文档 |
|------|------|---------|
| Canvas 坐标系与像素比（devicePixelRatio）适配 | ⭐⭐ | [性能优化专题](./04-performance.md) |
| 虚拟滚动在 Canvas 表格中的实现原理 | ⭐⭐⭐ | [表格绘制专题](./03-table-rendering.md) |
| requestAnimationFrame 与帧率控制 | ⭐⭐ | [性能优化专题](./04-performance.md) |
| Canvas 事件系统（鼠标命中检测）实现原理 | ⭐⭐⭐ | [实战应用专题](./05-practical-cases.md) |
| OffscreenCanvas 与 Web Worker 结合使用 | ⭐⭐⭐ | [Canvas 进阶](./02-canvas-advanced.md) |

---

### 🔥 阿里高频

| 考点 | 难度 | 所在文档 |
|------|------|---------|
| Canvas 路径绘制（arc/bezierCurveTo）原理 | ⭐⭐ | [Canvas 基础](./01-canvas-basics.md) |
| 变换矩阵（translate/rotate/scale）原理与应用 | ⭐⭐ | [Canvas 进阶](./02-canvas-advanced.md) |
| 分层渲染（多 Canvas 叠加）策略 | ⭐⭐⭐ | [性能优化专题](./04-performance.md) |
| Canvas vs SVG 数据可视化选型对比 | ⭐⭐⭐ | [实战应用专题](./05-practical-cases.md) |
| 单元格合并（rowspan/colspan）坐标计算 | ⭐⭐⭐ | [表格绘制专题](./03-table-rendering.md) |

---

### 🔥 腾讯高频

| 考点 | 难度 | 所在文档 |
|------|------|---------|
| Canvas 状态管理（save/restore）与裁剪（clip） | ⭐⭐ | [Canvas 进阶](./02-canvas-advanced.md) |
| 图像处理（getImageData/putImageData）像素操作 | ⭐⭐⭐ | [Canvas 进阶](./02-canvas-advanced.md) |
| 脏矩形（Dirty Rectangle）局部重绘优化 | ⭐⭐⭐ | [性能优化专题](./04-performance.md) |
| ECharts 底层渲染原理 | ⭐⭐⭐ | [实战应用专题](./05-practical-cases.md) |
| 固定表头与冻结列实现思路 | ⭐⭐ | [表格绘制专题](./03-table-rendering.md) |

---

### 🔥 美团高频

| 考点 | 难度 | 所在文档 |
|------|------|---------|
| Canvas 渐变（线性渐变/径向渐变）与阴影 | ⭐ | [Canvas 基础](./01-canvas-basics.md) |
| DOM 表格 vs Canvas 表格方案对比 | ⭐⭐ | [表格绘制专题](./03-table-rendering.md) |
| 大数据量表格内存管理与 GC 压力控制 | ⭐⭐⭐ | [性能优化专题](./04-performance.md) |
| 拖拽调整列宽的 Canvas 表格完整思路 | ⭐⭐⭐ | [实战应用专题](./05-practical-cases.md) |
| 文字溢出省略与自动换行处理 | ⭐⭐ | [表格绘制专题](./03-table-rendering.md) |

---

## 延伸阅读

- [MDN Canvas API 中文文档](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API) — 官方权威参考，涵盖所有 Canvas 2D 上下文方法与属性
- [HTML Living Standard — The canvas element](https://html.spec.whatwg.org/multipage/canvas.html) — W3C/WHATWG 官方规范，了解 Canvas 底层标准
- [OffscreenCanvas — MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) — OffscreenCanvas 官方文档，含兼容性数据与 Web Worker 使用示例
- [fast-check — Property Based Testing for JavaScript](https://fast-check.io/) — 本图谱属性测试所使用的框架文档
- [ECharts 源码 — Apache GitHub](https://github.com/apache/echarts) — 了解工业级 Canvas 图表库的底层实现思路
