# Tailwind CSS 面试题

---

## 基础概念

### Q1：Tailwind CSS 是什么？和传统 CSS 框架（Bootstrap）有什么区别？

Tailwind 是一个 utility-first 的 CSS 框架，提供大量原子类，直接在 HTML 上组合样式，不预设组件。

| | Bootstrap | Tailwind |
|--|-----------|----------|
| 思路 | 组件优先（`.btn`、`.card`） | 工具类优先（`flex p-4 bg-blue-500`） |
| 定制性 | 需要覆盖默认样式 | 配置文件直接定制 |
| 包体积 | 全量引入较大 | PurgeCSS 按需生成，极小 |
| 学习曲线 | 低（直接用组件） | 需要记类名 |
| 设计一致性 | 依赖框架风格 | 基于设计系统，高度一致 |

---

### Q2：Tailwind 的核心原理是什么？为什么生产包体积很小？

Tailwind v3 使用 JIT（Just-In-Time）引擎，扫描源文件中用到的类名，按需生成对应 CSS，未使用的样式不会出现在最终产物中。

```javascript
// tailwind.config.js
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}', // 扫描这些文件中的类名
  ],
}
```

JIT 的额外好处：
- 支持任意值（arbitrary values）：`w-[137px]`、`bg-[#1a2b3c]`
- 支持动态类名变体：`hover:`、`dark:`、`md:` 等按需生成
- 开发环境也很快，不需要预生成所有类

---

### Q3：常用的工具类有哪些？说说布局相关的

```html
<!-- Flexbox -->
<div class="flex items-center justify-between gap-4">
  <span class="flex-1">左侧内容</span>
  <button class="flex-shrink-0">按钮</button>
</div>

<!-- Grid -->
<div class="grid grid-cols-3 gap-6">
  <div class="col-span-2">主内容</div>
  <div>侧边栏</div>
</div>

<!-- 定位 -->
<div class="relative">
  <div class="absolute top-0 right-0 translate-x-1/2 -translate-y-1/2">
    角标
  </div>
</div>

<!-- 响应式 -->
<div class="w-full md:w-1/2 lg:w-1/3">
  <!-- 移动端全宽，平板半宽，桌面三分之一 -->
</div>
```

---

## 响应式与变体

### Q4：Tailwind 的响应式断点怎么用？默认有哪些？

Tailwind 采用移动优先，断点前缀表示"在该断点及以上生效"：

| 前缀 | 最小宽度 |
|------|---------|
| `sm:` | 640px |
| `md:` | 768px |
| `lg:` | 1024px |
| `xl:` | 1280px |
| `2xl:` | 1536px |

```html
<!-- 移动端堆叠，md 以上横排 -->
<div class="flex flex-col md:flex-row">
  <div class="w-full md:w-64">侧边栏</div>
  <div class="flex-1">内容</div>
</div>

<!-- 自定义断点 -->
```
```javascript
// tailwind.config.js
theme: {
  screens: {
    'xs': '480px',
    'sm': '640px',
    // 覆盖或扩展默认断点
  }
}
```

---

### Q5：常用的状态变体有哪些？

```html
<!-- 交互状态 -->
<button class="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 focus:ring-2">
  按钮
</button>

<!-- 表单状态 -->
<input class="border disabled:opacity-50 disabled:cursor-not-allowed
              invalid:border-red-500 focus:outline-none focus:ring-2" />

<!-- 深色模式 -->
<div class="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">

<!-- 父元素状态（group） -->
<div class="group cursor-pointer">
  <p class="text-gray-500 group-hover:text-blue-500">悬停父元素时变色</p>
</div>

<!-- 兄弟元素状态（peer） -->
<input type="checkbox" class="peer" />
<label class="text-gray-500 peer-checked:text-blue-500">选中时变色</label>
```

---

### Q6：深色模式如何配置和使用？

```javascript
// tailwind.config.js
export default {
  darkMode: 'class', // 通过 class 切换（推荐）
  // darkMode: 'media', // 跟随系统设置
}
```

```html
<!-- html 标签加 dark class 即可切换 -->
<html class="dark">
  <div class="bg-white dark:bg-gray-900">
    <p class="text-black dark:text-white">内容</p>
  </div>
</html>
```

```javascript
// 切换深色模式
function toggleDark() {
  document.documentElement.classList.toggle('dark');
}
```

---

## 自定义与配置

### Q7：如何扩展 Tailwind 的主题？`extend` 和直接覆盖有什么区别？

```javascript
// tailwind.config.js
export default {
  theme: {
    // 直接写：完全替换默认值（慎用，会丢失所有默认颜色/间距）
    colors: {
      primary: '#3b82f6',
    },

    extend: {
      // 推荐：在默认值基础上扩展
      colors: {
        primary: {
          50: '#eff6ff',
          500: '#3b82f6',
          900: '#1e3a8a',
        },
        brand: '#ff6b35',
      },
      spacing: {
        '18': '4.5rem',
        '128': '32rem',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
}
```

---

### Q8：什么是任意值（Arbitrary Values）？什么时候用？

JIT 支持在方括号中写任意 CSS 值，处理设计稿中的特殊数值：

```html
<!-- 特殊尺寸 -->
<div class="w-[137px] h-[calc(100vh-64px)]">

<!-- 特殊颜色 -->
<div class="bg-[#1a2b3c] text-[rgb(255,100,0)]">

<!-- 特殊字体大小 -->
<p class="text-[13px] leading-[1.8]">

<!-- CSS 变量 -->
<div class="bg-[var(--brand-color)]">

<!-- 复杂选择器（任意变体） -->
<div class="[&>li]:mb-2 [&:nth-child(3)]:bg-blue-100">
```

注意：任意值是逃生舱，频繁使用说明设计系统需要完善，应该在 config 中统一定义。

---

### Q9：如何添加自定义工具类？`@layer` 的作用是什么？

```css
/* main.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* 自定义基础样式（优先级最低） */
@layer base {
  h1 { @apply text-2xl font-bold; }
  a  { @apply text-blue-500 hover:underline; }
}

/* 自定义组件类（可被工具类覆盖） */
@layer components {
  .btn {
    @apply px-4 py-2 rounded font-medium transition-colors;
  }
  .btn-primary {
    @apply btn bg-blue-500 text-white hover:bg-blue-600;
  }
  .card {
    @apply bg-white rounded-lg shadow p-6;
  }
}

/* 自定义工具类（优先级最高） */
@layer utilities {
  .text-balance { text-wrap: balance; }
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  }
}
```

`@layer` 的作用：将样式放入对应层，确保优先级正确，且未使用时会被 PurgeCSS 移除。

---

## 工程实践

### Q10：`@apply` 的使用场景和注意事项？

```css
/* 适合用 @apply 的场景：复用的组件样式 */
.btn {
  @apply inline-flex items-center px-4 py-2 rounded-md font-medium
         transition-colors focus:outline-none focus:ring-2;
}
```

注意事项：
- 不要在 JS/Vue 组件中滥用 `@apply`，失去了 Tailwind 的可读性优势
- `@apply` 不能使用响应式前缀（`md:flex` 不能 apply）和状态变体（`hover:bg-blue-500` 不能 apply）
- 过度使用 `@apply` 等于回到了传统 CSS 写法，违背 utility-first 理念

---

### Q11：Tailwind 如何与 Vue/React 组件配合？如何避免类名过长？

```vue
<!-- Vue：用计算属性或 clsx 管理动态类名 -->
<script setup>
import { computed } from 'vue';
const props = defineProps({ variant: String, size: String });

const classes = computed(() => ({
  'px-4 py-2 text-sm': props.size === 'sm',
  'px-6 py-3 text-base': props.size === 'md',
  'bg-blue-500 text-white hover:bg-blue-600': props.variant === 'primary',
  'bg-gray-100 text-gray-900 hover:bg-gray-200': props.variant === 'secondary',
}));
</script>

<template>
  <button :class="['rounded font-medium transition-colors', classes]">
    <slot />
  </button>
</template>
```

```typescript
// 推荐：clsx + tailwind-merge 处理条件类名和冲突
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// cn 工具函数（shadcn/ui 的标配）
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// 使用
cn('px-4 py-2', isLarge && 'px-6 py-3', 'bg-blue-500')
// tailwind-merge 会自动解决 px-4 和 px-6 的冲突，保留后者
```

---

### Q12：`tailwind-merge` 解决了什么问题？

Tailwind 类名冲突时，CSS 优先级由样式表顺序决定，而不是 HTML 中的类名顺序，导致覆盖行为不可预测。

```javascript
// 问题：想用 px-6 覆盖 px-4，但实际哪个生效取决于 CSS 文件顺序
<div class="px-4 px-6">  // 不确定哪个生效

// tailwind-merge 解决：智能合并，后面的同类属性覆盖前面的
twMerge('px-4 py-2', 'px-6')  // → 'py-2 px-6'
twMerge('text-red-500', 'text-blue-500')  // → 'text-blue-500'
twMerge('rounded', 'rounded-lg')  // → 'rounded-lg'
```

---

### Q13：Tailwind CSS v4 有哪些主要变化？

Tailwind v4（2025年发布）的核心变化：

1. 配置迁移到 CSS 文件，不再需要 `tailwind.config.js`：
```css
/* 直接在 CSS 中配置 */
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --font-sans: 'Inter', sans-serif;
  --breakpoint-3xl: 1920px;
}
```

2. 性能大幅提升：基于 Rust 重写的引擎（Lightning CSS），比 v3 快 5-10 倍

3. 原生 CSS 变量：所有 token 自动生成 CSS 变量，可直接在 JS 中使用

4. 不再需要 `content` 配置，自动检测源文件

5. 新增 `@variant` 自定义变体：
```css
@variant dark (&:where(.dark, .dark *));
```

---

### Q14：如何在 Vite + Vue 项目中集成 Tailwind CSS v4？

```bash
npm install tailwindcss @tailwindcss/vite
```

```typescript
// vite.config.ts
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(), // 替代 postcss 配置
  ],
});
```

```css
/* src/main.css */
@import "tailwindcss";

/* 自定义主题 */
@theme {
  --color-brand: #ff6b35;
}
```

```typescript
// main.ts
import './main.css';
```

v4 不再需要 `postcss.config.js` 和 `tailwind.config.js`，配置更简洁。
