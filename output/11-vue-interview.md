# Vue 面试题

---

## 基础

### Q1：Vue2 和 Vue3 的主要区别？

| 维度 | Vue2 | Vue3 |
|------|------|------|
| 响应式 | Object.defineProperty | Proxy |
| API 风格 | Options API | Composition API（兼容 Options） |
| 根节点 | 单根节点 | 支持多根节点（Fragment） |
| TypeScript | 支持较弱 | 原生 TS 支持 |
| 性能 | - | 更小的包体积，更快的渲染 |
| 生命周期 | beforeDestroy/destroyed | onBeforeUnmount/onUnmounted |

Vue3 响应式用 Proxy 的优势：
- 可以检测属性的新增和删除（Vue2 需要 `$set`）
- 可以检测数组索引赋值和 length 修改
- 惰性代理，只在访问时才递归代理嵌套对象

---

### Q2：`v-if` 和 `v-show` 的区别？

- `v-if`：条件为 false 时元素不渲染到 DOM，切换时有销毁/创建的开销，适合不频繁切换的场景
- `v-show`：始终渲染，只是切换 `display: none`，适合频繁切换的场景

`v-if` 优先级高于 `v-for`（Vue3），不建议同时使用在同一元素上，应用 `<template>` 包裹。

---

### Q3：`v-for` 为什么需要 `key`？

key 帮助 Vue 的 diff 算法识别节点身份，实现最小化 DOM 操作。

没有 key 时，Vue 使用"就地复用"策略，按位置复用节点，可能导致状态错乱（如输入框内容错位）。

有 key 时，Vue 可以准确找到对应节点，进行移动而不是销毁重建。

key 应该是稳定唯一的值（如 id），不要用 index（列表顺序变化时 index 会变，失去意义）。

---

## 响应式

### Q4：Vue3 的 `ref` 和 `reactive` 有什么区别？

```javascript
import { ref, reactive } from 'vue';

// ref：包装任意类型，通过 .value 访问
const count = ref(0);
count.value++;

// reactive：只能包装对象，直接访问属性
const state = reactive({ count: 0, name: 'Alice' });
state.count++;
```

选择原则：
- 基本类型必须用 `ref`
- 对象用 `reactive` 更方便（不需要 .value）
- 但 `reactive` 解构后会失去响应性，需要用 `toRefs`

```javascript
const state = reactive({ x: 1, y: 2 });
const { x, y } = toRefs(state); // x.value, y.value 仍然响应式
```

---

### Q5：`computed` 和 `watch` 的区别？

`computed`：
- 基于依赖缓存，依赖不变不重新计算
- 必须有返回值
- 适合从已有数据派生新数据

`watch`：
- 监听数据变化，执行副作用
- 可以访问新旧值
- 适合异步操作、数据变化时调用 API

```javascript
const fullName = computed(() => `${firstName.value} ${lastName.value}`);

watch(userId, async (newId, oldId) => {
  userData.value = await fetchUser(newId);
}, { immediate: true }); // immediate: 立即执行一次

// watchEffect：自动收集依赖
watchEffect(async () => {
  // 访问了 userId.value，自动追踪
  userData.value = await fetchUser(userId.value);
});
```

---

### Q6：Vue3 响应式原理简述

```javascript
// 核心：Proxy 拦截 get/set
function reactive(raw) {
  return new Proxy(raw, {
    get(target, key) {
      track(target, key);  // 收集依赖（当前正在运行的 effect）
      return Reflect.get(target, key);
    },
    set(target, key, value) {
      Reflect.set(target, key, value);
      trigger(target, key); // 触发依赖更新
      return true;
    }
  });
}
```

依赖收集：`effect`（computed/watch/组件渲染函数）运行时，访问响应式数据会触发 `track`，将当前 effect 存入该属性的依赖集合。数据变化时 `trigger` 重新运行所有依赖的 effect。

---

## 组件

### Q7：组件通信有哪些方式？

```javascript
// 1. props / emit（父子）
// 父 → 子
<Child :data="parentData" />
// 子 → 父
const emit = defineEmits(['update']);
emit('update', newValue);

// 2. v-model（语法糖）
// 等价于 :modelValue + @update:modelValue
<Input v-model="value" />

// 3. provide / inject（跨层级）
// 祖先
provide('theme', ref('dark'));
// 后代
const theme = inject('theme');

// 4. Pinia / Vuex（全局状态）

// 5. $attrs（透传未声明的属性）
// 6. ref（父组件访问子组件实例）
const childRef = ref(null);
// <Child ref="childRef" />
// childRef.value.someMethod()
```

---

### Q8：`defineExpose` 是什么？什么时候用？

Vue3 中使用 `<script setup>` 的组件，内部变量默认不对外暴露。`defineExpose` 用于显式暴露给父组件通过 `ref` 访问的内容。

```javascript
// 子组件
const count = ref(0);
const reset = () => { count.value = 0; };
defineExpose({ count, reset });

// 父组件
const childRef = ref(null);
childRef.value.reset(); // 可以调用
```

---

### Q9：Vue 的 `keep-alive` 是什么？有哪些生命周期？

`<keep-alive>` 缓存组件实例，切换时不销毁，保留状态。

```html
<keep-alive :include="['Home', 'List']" :max="10">
  <component :is="currentComponent" />
</keep-alive>
```

被缓存的组件新增两个生命周期：
- `onActivated`：组件被激活（从缓存中取出）时触发
- `onDeactivated`：组件被停用（放入缓存）时触发

适用场景：列表页 → 详情页 → 返回列表页时保留滚动位置和数据。

---

## 生命周期

### Q10：Vue3 的生命周期钩子有哪些？

```javascript
import { onBeforeMount, onMounted, onBeforeUpdate, onUpdated,
         onBeforeUnmount, onUnmounted, onErrorCaptured } from 'vue';

// setup() 本身相当于 beforeCreate + created

onMounted(() => {
  // DOM 已挂载，可以操作 DOM、发起请求
});

onBeforeUnmount(() => {
  // 清理副作用：取消订阅、清除定时器
  clearInterval(timer);
});

onErrorCaptured((err, instance, info) => {
  // 捕获子组件错误，返回 false 阻止向上传播
  return false;
});
```

---

## 路由

### Q11：Vue Router 的导航守卫有哪些？执行顺序？

```javascript
// 全局守卫
router.beforeEach((to, from) => {
  if (to.meta.requiresAuth && !isLoggedIn()) return '/login';
});
router.afterEach((to, from) => { /* 统计、修改 title */ });

// 路由独享守卫
{
  path: '/admin',
  beforeEnter: (to, from) => { /* ... */ }
}

// 组件内守卫
onBeforeRouteLeave((to, from) => {
  if (hasUnsavedChanges) return false; // 阻止离开
});
```

执行顺序：
1. 全局 `beforeEach`
2. 路由独享 `beforeEnter`
3. 组件内 `beforeRouteEnter`
4. 全局 `afterEach`

---

### Q12：`hash` 模式和 `history` 模式的区别？

| | hash 模式 | history 模式 |
|--|-----------|-------------|
| URL 格式 | `/#/path` | `/path` |
| 原理 | `hashchange` 事件 | HTML5 History API |
| 服务端配置 | 不需要 | 需要（所有路径返回 index.html） |
| SEO | 较差 | 较好 |

history 模式服务端配置（Nginx）：
```nginx
location / {
  try_files $uri $uri/ /index.html;
}
```

---

## Pinia

### Q13：Pinia 和 Vuex 的区别？

| | Vuex | Pinia |
|--|------|-------|
| 模块化 | 需要 modules 嵌套 | 每个 store 独立，扁平化 |
| TypeScript | 支持较弱 | 原生 TS 支持 |
| mutations | 必须通过 mutation 修改 | 直接修改 state |
| devtools | 支持 | 支持 |
| 体积 | 较大 | 更小 |

```javascript
// Pinia store
export const useUserStore = defineStore('user', () => {
  const name = ref('');
  const isLoggedIn = computed(() => !!name.value);

  async function login(credentials) {
    const data = await api.login(credentials);
    name.value = data.name;
  }

  return { name, isLoggedIn, login };
});

// 使用
const userStore = useUserStore();
userStore.login({ username: 'alice', password: '...' });
```

---

## 性能优化

### Q14：Vue 项目常见的性能优化手段？

- `v-once`：只渲染一次，跳过后续更新
- `v-memo`：缓存子树，依赖不变时跳过更新
- `shallowRef` / `shallowReactive`：浅层响应式，避免深层代理开销
- 路由懒加载：`() => import('./views/Home.vue')`
- 组件懒加载：`defineAsyncComponent`
- 长列表：虚拟滚动（vue-virtual-scroller）
- 图片懒加载：`loading="lazy"` 或 IntersectionObserver
- 合理使用 `keep-alive` 缓存组件

---

### Q15：Vue3 的 `Teleport` 和 `Suspense` 是什么？

`Teleport`：将组件渲染到 DOM 中的指定位置，常用于 Modal、Toast（避免 z-index 和 overflow 问题）。

```html
<Teleport to="body">
  <Modal v-if="showModal" />
</Teleport>
```

`Suspense`：等待异步组件或异步 setup 完成，期间显示 fallback 内容。

```html
<Suspense>
  <template #default><AsyncComponent /></template>
  <template #fallback><Loading /></template>
</Suspense>
```
