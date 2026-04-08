# CSS 面试题

---

## 盒模型

### Q1：标准盒模型和 IE 盒模型的区别？

标准盒模型（`box-sizing: content-box`）：width/height 只包含内容区，padding 和 border 会撑大元素。

IE 盒模型（`box-sizing: border-box`）：width/height 包含 content + padding + border，更符合直觉，实际开发中推荐全局设置。

```css
*, *::before, *::after {
  box-sizing: border-box;
}
```

---

### Q2：margin 塌陷（collapse）是什么？怎么触发，怎么避免？

相邻块级元素的垂直 margin 会合并取较大值，而不是相加。父子元素之间也会塌陷（父元素没有 border/padding 隔开时）。

触发场景：
- 相邻兄弟元素垂直 margin
- 父元素与第一个/最后一个子元素之间

避免方式：
- 父元素加 `overflow: hidden` 或 `display: flow-root`（触发 BFC）
- 父元素加 `border` 或 `padding`
- 改用 flex/grid 布局（flex 容器内不发生塌陷）

---

## 布局

### Q3：BFC 是什么？有哪些触发条件？

BFC（块级格式化上下文）是一个独立的渲染区域，内部元素不影响外部布局。

触发条件：
- `overflow` 不为 visible（hidden/auto/scroll）
- `display: flow-root`（专门用来触发 BFC，无副作用）
- `float` 不为 none
- `position: absolute / fixed`
- `display: flex / grid` 的子项

常见用途：
- 清除浮动（父元素触发 BFC 可包裹浮动子元素）
- 防止 margin 塌陷
- 阻止文字环绕浮动元素

---

### Q4：flex 布局中 `flex: 1` 是什么的简写？

`flex: 1` 等价于 `flex: 1 1 0`，即：
- `flex-grow: 1`：有剩余空间时按比例放大
- `flex-shrink: 1`：空间不足时按比例缩小
- `flex-basis: 0`：初始尺寸为 0，完全由 grow/shrink 决定

常见对比：
- `flex: auto` = `flex: 1 1 auto`，basis 是内容尺寸
- `flex: none` = `flex: 0 0 auto`，不伸缩

---

### Q5：grid 布局如何实现响应式列数？

```css
.grid {
  display: grid;
  /* 自动填充列，每列最小 200px，最大平分剩余空间 */
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
```

`auto-fill` vs `auto-fit`：
- `auto-fill`：尽可能多创建列（即使是空列）
- `auto-fit`：空列折叠为 0，已有内容的列撑满容器

---

### Q6：水平垂直居中有哪些方案？

```css
/* 方案1：flex（推荐） */
.parent { display: flex; justify-content: center; align-items: center; }

/* 方案2：grid */
.parent { display: grid; place-items: center; }

/* 方案3：absolute + transform（不需要知道子元素尺寸） */
.parent { position: relative; }
.child  { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }

/* 方案4：absolute + margin auto（需要知道子元素尺寸） */
.child  { position: absolute; inset: 0; margin: auto; width: 100px; height: 100px; }
```

---

## 选择器与优先级

### Q7：CSS 优先级怎么计算？

优先级用 (a, b, c) 三元组表示：
- a：内联样式（style=""）= 1000
- b：ID 选择器 = 100
- c：类、伪类、属性选择器 = 10；元素、伪元素 = 1

```css
#nav .item:hover span  /* (0, 1, 1, 2) = 0112 */
.container > .item     /* (0, 0, 2, 0) = 0020 */
```

`!important` 优先级最高，但会破坏级联，尽量避免。

`:where()` 优先级为 0，`:is()` 取参数中最高优先级。

---

### Q8：伪类和伪元素的区别？常用的有哪些？

伪类（单冒号）：选择元素的特定状态
- `:hover` `:focus` `:active` `:visited`
- `:nth-child(n)` `:first-child` `:last-child` `:not()`
- `:checked` `:disabled` `:placeholder-shown`

伪元素（双冒号）：创建不在 DOM 中的虚拟元素
- `::before` `::after`：配合 `content` 插入内容
- `::placeholder`：输入框占位符样式
- `::selection`：用户选中文本的样式
- `::first-line` `::first-letter`

---

## 定位与层叠

### Q9：`position` 各个值的区别？

| 值 | 参照物 | 是否脱离文档流 |
|----|--------|--------------|
| static | 无（默认） | 否 |
| relative | 自身原始位置 | 否（占位保留） |
| absolute | 最近的非 static 祖先 | 是 |
| fixed | 视口 | 是 |
| sticky | 滚动容器，在 relative 和 fixed 之间切换 | 否 |

sticky 失效常见原因：父元素设置了 `overflow: hidden/auto`。

---

### Q10：z-index 不生效怎么排查？

z-index 只对定位元素（position 非 static）生效。

更常见的原因是层叠上下文：元素的 z-index 只在同一层叠上下文内比较。父元素如果创建了新的层叠上下文（opacity < 1、transform、filter 等），子元素的 z-index 再大也无法超出父元素的层级。

排查步骤：
1. 确认元素有 position 且非 static
2. 检查父元素是否意外创建了层叠上下文
3. 用 `isolation: isolate` 显式创建上下文，避免意外影响

---

## 响应式与适配

### Q11：rem、em、vw 的区别和使用场景？

- `em`：相对于当前元素的 font-size，嵌套时会累乘，适合组件内部间距
- `rem`：相对于根元素（html）的 font-size，全局统一，适合整体布局缩放
- `vw/vh`：相对于视口宽高，适合全屏布局、字体随屏幕缩放

移动端适配常见方案：
```css
/* 方案1：rem + 动态设置 html font-size */
html { font-size: calc(100vw / 375 * 16); } /* 以 375px 设计稿为基准 */

/* 方案2：直接用 vw */
.title { font-size: 4.267vw; } /* 16px / 375 * 100 */

/* 方案3：clamp 响应式字体 */
.title { font-size: clamp(14px, 4vw, 20px); }
```

---

### Q12：`@media` 查询的常用断点和移动优先写法？

```css
/* 移动优先：先写小屏，用 min-width 向上覆盖 */
.container { padding: 16px; }

@media (min-width: 768px) {
  .container { padding: 24px; max-width: 960px; margin: 0 auto; }
}

@media (min-width: 1200px) {
  .container { max-width: 1200px; }
}

/* 其他常用媒体特性 */
@media (prefers-color-scheme: dark) { /* 深色模式 */ }
@media (prefers-reduced-motion: reduce) { /* 减少动画 */ }
@media (hover: none) { /* 触摸设备，无 hover */ }
```

---

## 动画与性能

### Q13：CSS 动画 `transition` 和 `animation` 的区别？

`transition`：状态 A → 状态 B 的过渡，需要触发条件（hover/class 变化），只有起止两帧。

`animation`：通过 `@keyframes` 定义多帧动画，可自动播放、循环、暂停。

```css
/* transition */
.btn { background: blue; transition: background 0.3s ease; }
.btn:hover { background: red; }

/* animation */
@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.loader { animation: spin 1s linear infinite; }
```

---

### Q14：哪些 CSS 属性动画性能好？为什么？

性能最好的是 `transform` 和 `opacity`，因为它们只触发合成（Composite）阶段，由 GPU 处理，不引起 reflow 或 repaint。

```css
/* 好：只触发合成 */
.slide { transition: transform 0.3s; }
.slide.active { transform: translateX(0); }

/* 差：触发 layout + paint */
.slide { transition: left 0.3s; }
.slide.active { left: 0; }
```

需要动画其他属性时，用 `will-change: transform` 提前提升为合成层，但不要滥用（每个合成层都消耗内存）。

---

## 其他

### Q15：`display: none`、`visibility: hidden`、`opacity: 0` 的区别？

| | 占位 | 响应事件 | 子元素可覆盖 | 触发重排 |
|--|------|---------|------------|---------|
| `display: none` | 否 | 否 | 否 | 是 |
| `visibility: hidden` | 是 | 否 | 是（`visibility: visible`） | 否 |
| `opacity: 0` | 是 | 是 | 否 | 否 |

---

### Q16：CSS 变量（自定义属性）有什么优势？

```css
:root {
  --color-primary: #3b82f6;
  --spacing-base: 8px;
}

.btn {
  background: var(--color-primary);
  padding: calc(var(--spacing-base) * 2);
}

/* 局部覆盖 */
.dark-theme {
  --color-primary: #60a5fa;
}

/* JS 动态修改 */
```
```javascript
document.documentElement.style.setProperty('--color-primary', '#ff0000');
```

优势：
- 运行时可修改（SCSS 变量编译后是静态值）
- 可以继承和局部覆盖
- 配合 JS 实现主题切换非常方便
- 可以在 `calc()` 中使用
