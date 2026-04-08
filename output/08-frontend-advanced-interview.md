# 高级前端工程化面试题

> 涵盖：JavaScript 深度、TypeScript 类型体操、CSS 工程化、性能优化、架构设计

---

## 一、JavaScript 深度

### Q1：说说 V8 的隐藏类（Hidden Class）机制，以及哪些写法会导致性能退化

**参考答案：**

V8 为每个对象维护一个隐藏类（也叫 Shape/Map），描述对象的属性布局。相同结构的对象共享隐藏类，可以用数组偏移量直接访问属性，避免哈希查找。

**导致隐藏类切换（性能退化）的写法：**

```javascript
// 坏：属性添加顺序不一致，产生两个不同隐藏类
function Point(x, y) { this.x = x; this.y = y; }
const p1 = new Point(1, 2);
const p2 = new Point(3, 4);
p2.z = 5; // p2 切换到新隐藏类，p1/p2 不再共享

// 坏：动态删除属性
delete p1.x; // 触发隐藏类切换，且可能退化为字典模式

// 坏：先创建对象再添加属性
const obj = {};
obj.a = 1; // 隐藏类 C0 → C1
obj.b = 2; // 隐藏类 C1 → C2

// 好：构造时一次性定义所有属性
function Point(x, y) {
  this.x = x; // 所有实例属性顺序一致
  this.y = y;
}
```

**数组的类似问题：**
```javascript
// 坏：混合类型数组，从 SMI_ELEMENTS 退化到 ELEMENTS_KIND
const arr = [1, 2, 3];    // SMI（小整数），最快
arr.push(1.5);             // 退化为 DOUBLE_ELEMENTS
arr.push('str');           // 退化为 ELEMENTS，最慢，且不可逆
```

---

### Q2：EventLoop 中 microtask 和 macrotask 的执行顺序，以及 `queueMicrotask` vs `Promise.resolve` 的区别

**参考答案：**

```javascript
console.log('1');

setTimeout(() => console.log('2'), 0);       // macrotask

Promise.resolve().then(() => {
  console.log('3');
  Promise.resolve().then(() => console.log('4')); // 嵌套 microtask
});

queueMicrotask(() => console.log('5'));

console.log('6');

// 输出：1 6 3 5 4 2
```

执行顺序：
1. 同步代码（1, 6）
2. 清空 microtask 队列（3 → 产生新 microtask 4 → 5 → 4）
3. 取下一个 macrotask（2）
4. 再次清空 microtask 队列

`queueMicrotask` vs `Promise.resolve().then`：
- 功能等价，都是入 microtask 队列
- `queueMicrotask` 语义更清晰，不创建 Promise 对象，无 GC 压力
- `Promise.resolve().then` 的回调如果抛错会变成 unhandledRejection；`queueMicrotask` 的错误直接抛到全局

---

### Q3：WeakRef 和 FinalizationRegistry 的使用场景，以及为什么不能依赖它们做业务逻辑

**参考答案：**

```typescript
// 场景：缓存大对象，但不阻止 GC 回收
class ImageCache {
  private cache = new Map<string, WeakRef<ImageBitmap>>();
  private registry = new FinalizationRegistry((key: string) => {
    this.cache.delete(key); // 对象被 GC 时清理 Map 条目
    console.log(`Cache entry ${key} was GC'd`);
  });

  set(key: string, bitmap: ImageBitmap) {
    this.cache.set(key, new WeakRef(bitmap));
    this.registry.register(bitmap, key);
  }

  get(key: string): ImageBitmap | undefined {
    return this.cache.get(key)?.deref(); // deref() 返回对象或 undefined
  }
}
```

**为什么不能依赖做业务逻辑：**
1. GC 时机不确定，同一代码在不同 JS 引擎、不同内存压力下行为不同
2. `FinalizationRegistry` 回调可能在任意时机触发，甚至程序退出前不触发
3. 规范明确说明：不保证回调一定被调用

正确用途：仅用于缓存优化、调试、内存泄漏检测，不能用于资源释放等关键逻辑。

---

### Q4：实现一个支持并发限制的异步任务调度器

**参考答案：**

```typescript
class Scheduler {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private concurrency: number) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await task()); }
        catch (e) { reject(e); }
        finally {
          this.running--;
          this.next();
        }
      });
      this.next();
    });
  }

  private next() {
    while (this.running < this.concurrency && this.queue.length) {
      this.running++;
      this.queue.shift()!();
    }
  }
}

// 使用
const scheduler = new Scheduler(2); // 最多同时跑 2 个
const tasks = [1,2,3,4,5].map(i =>
  scheduler.add(() => fetch(`/api/${i}`).then(r => r.json()))
);
const results = await Promise.all(tasks);
```

---

### Q5：Proxy 和 Reflect 的配合使用，实现一个响应式系统的核心

**参考答案：**

```typescript
type Effect = () => void;
const effectStack: Effect[] = [];
const targetMap = new WeakMap<object, Map<string | symbol, Set<Effect>>>();

function track(target: object, key: string | symbol) {
  const effect = effectStack.at(-1);
  if (!effect) return;
  let depsMap = targetMap.get(target);
  if (!depsMap) targetMap.set(target, depsMap = new Map());
  let deps = depsMap.get(key);
  if (!deps) depsMap.set(key, deps = new Set());
  deps.add(effect);
}

function trigger(target: object, key: string | symbol) {
  targetMap.get(target)?.get(key)?.forEach(e => e());
}

function reactive<T extends object>(raw: T): T {
  return new Proxy(raw, {
    get(target, key, receiver) {
      track(target, key);
      return Reflect.get(target, key, receiver); // 用 Reflect 保持 this 正确
    },
    set(target, key, value, receiver) {
      const result = Reflect.set(target, key, value, receiver);
      trigger(target, key);
      return result;
    },
  });
}

function watchEffect(fn: Effect) {
  const run = () => {
    effectStack.push(run);
    try { fn(); } finally { effectStack.pop(); }
  };
  run();
}

// 测试
const state = reactive({ count: 0 });
watchEffect(() => console.log('count:', state.count)); // 立即输出 count: 0
state.count++; // 输出 count: 1
```

**为什么要用 Reflect 而不是直接操作 target：**
- `Reflect.get(target, key, receiver)` 中 receiver 是 Proxy 本身，保证 getter 里的 `this` 指向 Proxy，从而触发嵌套属性的 track
- 直接 `target[key]` 会绕过 Proxy，嵌套对象的依赖收集失效

---

## 二、TypeScript 类型体操

### Q6：实现 DeepReadonly、DeepPartial、DeepRequired

**参考答案：**

```typescript
// DeepReadonly
type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

// DeepPartial
type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// DeepRequired
type DeepRequired<T> = T extends object
  ? { [K in keyof T]-?: DeepRequired<T[K]> }  // -? 移除可选修饰符
  : T;

// 测试
type Config = { db: { host: string; port?: number }; debug?: boolean };
type RC = DeepReadonly<Config>;
// { readonly db: { readonly host: string; readonly port?: number }; readonly debug?: boolean }
```

---

### Q7：实现 `PickByValue<T, V>` —— 按值类型筛选对象属性

**参考答案：**

```typescript
type PickByValue<T, V> = {
  [K in keyof T as T[K] extends V ? K : never]: T[K]
};

// 测试
type Mixed = { a: string; b: number; c: string; d: boolean };
type Strings = PickByValue<Mixed, string>; // { a: string; c: string }
type Numbers = PickByValue<Mixed, number | boolean>; // { b: number; d: boolean }
```

---

### Q8：实现 `Flatten<T>` —— 将嵌套数组类型展平

**参考答案：**

```typescript
type Flatten<T> = T extends Array<infer U> ? Flatten<U> : T;

type F1 = Flatten<number[][]>;          // number
type F2 = Flatten<string[][][]>;        // string
type F3 = Flatten<(number | string)[]>; // number | string

// 进阶：保留一层
type FlattenOnce<T extends unknown[]> = T extends Array<infer U>
  ? U extends unknown[] ? U[number] : U
  : never;
```

---

### Q9：实现一个类型安全的事件总线

**参考答案：**

```typescript
type EventMap = Record<string, unknown>;

class TypedEventEmitter<Events extends EventMap> {
  private listeners = new Map<keyof Events, Set<Function>>();

  on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }
}

// 使用：完全类型安全
interface AppEvents {
  'user:login': { userId: string; timestamp: number };
  'message:send': { content: string; roomId: string };
  'error': Error;
}

const bus = new TypedEventEmitter<AppEvents>();
bus.on('user:login', ({ userId }) => console.log(userId)); // userId: string ✓
bus.emit('user:login', { userId: 'u1', timestamp: Date.now() }); // ✓
// bus.emit('user:login', { userId: 123 }); // TS Error ✓
```

---

### Q10：`infer` 的高级用法 —— 提取函数重载的所有返回类型

**参考答案：**

```typescript
// 提取 Promise 内部类型
type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;

// 提取函数参数类型（指定位置）
type NthParam<T extends (...args: any) => any, N extends number> =
  Parameters<T>[N];

type F = (a: string, b: number, c: boolean) => void;
type Second = NthParam<F, 1>; // number

// 提取 getter 返回类型
type GetterReturnType<T> = {
  [K in keyof T as K extends `get${infer R}` ? Uncapitalize<R> : never]:
    T[K] extends () => infer R ? R : never
};

interface API {
  getName(): string;
  getAge(): number;
  setName(v: string): void;
}
type Getters = GetterReturnType<API>; // { name: string; age: number }
```

---

## 三、CSS 工程化

### Q11：CSS 层叠上下文（Stacking Context）的触发条件和常见坑

**参考答案：**

触发新层叠上下文的条件（常考的几个）：
- `position: relative/absolute/fixed/sticky` + `z-index` 非 auto
- `opacity < 1`
- `transform` 非 none
- `filter` 非 none
- `will-change` 指定了上述属性
- `isolation: isolate`（专门用来创建上下文）

**经典坑：**

```css
/* 坑1：子元素 z-index 再大也无法超出父层叠上下文 */
.parent { position: relative; z-index: 1; }
.child  { position: absolute; z-index: 9999; } /* 仍在 parent 的上下文内 */
.other  { position: relative; z-index: 2; }    /* 会覆盖整个 parent+child */

/* 坑2：opacity 创建上下文，导致 fixed 定位失效 */
.modal-overlay { opacity: 0.9; }               /* 创建了层叠上下文 */
.modal-content { position: fixed; }            /* fixed 相对于视口，但绘制层级被 overlay 限制 */

/* 解决：用 isolation 精确控制 */
.card { isolation: isolate; } /* 只创建上下文，不影响 opacity/transform */
```

---

### Q12：CSS 容器查询（Container Queries）vs 媒体查询，什么时候用哪个？

**参考答案：**

```css
/* 媒体查询：基于视口，适合页面级布局 */
@media (min-width: 768px) {
  .sidebar { display: block; }
}

/* 容器查询：基于父容器尺寸，适合组件级响应式 */
.card-container {
  container-type: inline-size;
  container-name: card;
}

@container card (min-width: 400px) {
  .card { flex-direction: row; } /* 容器够宽时横排 */
}
```

选择原则：
- 组件在不同位置复用（侧边栏/主内容区/弹窗）→ 容器查询
- 全局布局切换（移动端/桌面端导航）→ 媒体查询
- 组件库开发 → 优先容器查询，让使用方控制布局

---

### Q13：CSS `@layer` 解决了什么问题？如何与第三方库配合？

**参考答案：**

`@layer` 解决了样式优先级混乱问题，让开发者显式控制层叠顺序，不再依赖选择器权重。

```css
/* 声明层级顺序（后面的优先级更高） */
@layer reset, base, components, utilities;

@layer reset {
  * { box-sizing: border-box; margin: 0; }
}

@layer components {
  .btn { padding: 8px 16px; background: blue; }
}

@layer utilities {
  .mt-4 { margin-top: 16px; } /* 优先级高于 components */
}

/* 与 Tailwind/第三方库配合：把第三方样式放入低优先级层 */
@layer tailwind-base {
  @tailwind base;
}
@layer tailwind-components {
  @tailwind components;
}
/* 自己的样式不放 layer，优先级最高（无 layer 的样式 > 有 layer 的样式） */
```

---

## 四、工程化与性能

### Q14：描述一个大型前端项目的 Code Splitting 策略

**参考答案：**

```typescript
// 1. 路由级分割（最基础）
const Dashboard = lazy(() => import('./pages/Dashboard'));

// 2. 组件级分割（重型组件）
const RichEditor = lazy(() => import('./components/RichEditor'));
const Chart = lazy(() => import('./components/Chart'));

// 3. 按功能模块分割（避免过度分割）
// 坏：每个小组件都 lazy，HTTP 请求爆炸
// 好：把相关组件打包成一个 chunk
const AdminModule = lazy(() => import('./modules/admin')); // admin 下所有组件

// 4. 预加载策略
// 鼠标 hover 时预加载
<Link
  to="/dashboard"
  onMouseEnter={() => import('./pages/Dashboard')} // 预加载
>

// 5. webpack magic comments
const Modal = lazy(() => import(
  /* webpackChunkName: "modal" */
  /* webpackPrefetch: true */    // 空闲时预取
  './components/Modal'
));
```

分割粒度原则：
- 初始 bundle < 200KB（gzip）
- 单个 chunk 不超过 500KB
- 避免超过 20 个并行请求

---

### Q15：前端内存泄漏的常见场景和排查方法

**参考答案：**

**常见场景：**

```typescript
// 1. 未清理的事件监听
class Component {
  mount() {
    window.addEventListener('resize', this.handleResize); // 泄漏
  }
  // 修复：
  unmount() {
    window.removeEventListener('resize', this.handleResize);
  }
}

// 2. 闭包持有大对象引用
function createHandler() {
  const hugeData = new Array(1000000).fill(0); // 被闭包持有
  return () => console.log(hugeData.length);
}

// 3. 定时器未清理
const timer = setInterval(() => { /* 持有外部引用 */ }, 1000);
// 修复：clearInterval(timer)

// 4. React 中异步操作后 setState（组件已卸载）
useEffect(() => {
  let cancelled = false;
  fetchData().then(data => {
    if (!cancelled) setState(data); // 防止泄漏
  });
  return () => { cancelled = true; };
}, []);

// 5. Map/Set 持有 DOM 引用
const cache = new Map<HTMLElement, Data>(); // DOM 移除后 Map 仍持有引用
// 修复：用 WeakMap
const cache = new WeakMap<HTMLElement, Data>();
```

**排查方法：**
1. Chrome DevTools → Memory → Take Heap Snapshot，对比两次快照
2. Performance Monitor 观察 JS Heap 是否持续增长
3. Memory → Allocation instrumentation on timeline，找到分配但未释放的对象
4. 搜索 Detached DOM nodes（已从 DOM 树移除但仍被 JS 引用的节点）

---

### Q16：实现一个高性能的虚拟列表，说明关键设计点

**参考答案：**

```typescript
function VirtualList({ items, itemHeight, containerHeight }: {
  items: unknown[];
  itemHeight: number;
  containerHeight: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * itemHeight;
  const visibleCount = Math.ceil(containerHeight / itemHeight);
  const startIndex = Math.floor(scrollTop / itemHeight);
  // 上下各多渲染 3 个，防止快速滚动白屏
  const overscan = 3;
  const from = Math.max(0, startIndex - overscan);
  const to = Math.min(items.length, startIndex + visibleCount + overscan);

  const visibleItems = items.slice(from, to);
  const offsetY = from * itemHeight;

  return (
    <div
      style={{ height: containerHeight, overflow: 'auto' }}
      onScroll={e => setScrollTop((e.target as HTMLElement).scrollTop)}
    >
      {/* 撑开滚动高度 */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {/* 只渲染可见区域 */}
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map((item, i) => (
            <div key={from + i} style={{ height: itemHeight }}>
              {/* render item */}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

关键设计点：
1. `transform: translateY` 代替 `top/marginTop`，触发 GPU 合成层，不引起 reflow
2. overscan 缓冲区防止快速滚动白屏
3. 不定高列表：用 `ResizeObserver` 动态测量每项高度，维护高度缓存数组
4. 滚动事件节流（`requestAnimationFrame` 或 `passive: true`）

---

### Q17：`requestAnimationFrame` vs `requestIdleCallback` 的使用场景

**参考答案：**

```typescript
// rAF：与渲染帧同步，适合动画和 DOM 操作
function animate() {
  element.style.transform = `translateX(${x++}px)`;
  requestAnimationFrame(animate); // 每帧执行，约 16.7ms
}

// rIC：利用帧间空闲时间，适合非紧急后台任务
function processQueue(deadline: IdleDeadline) {
  // timeRemaining() 返回当前帧剩余空闲时间
  while (deadline.timeRemaining() > 1 && queue.length) {
    processItem(queue.shift());
  }
  if (queue.length) {
    requestIdleCallback(processQueue, { timeout: 2000 }); // timeout 保底执行
  }
}
requestIdleCallback(processQueue);
```

| 场景 | 用哪个 |
|------|--------|
| CSS 动画、canvas 绘制 | rAF |
| 批量 DOM 读取（getBoundingClientRect） | rAF |
| 数据预加载、日志上报 | rIC |
| 非关键 UI 更新 | rIC |
| React Concurrent 模式的时间切片 | rIC 思想（自己实现 scheduler） |

注意：`rIC` 在移动端和低端设备上空闲时间极少，`timeout` 参数很重要。

---

### Q18：描述浏览器渲染流水线，哪些操作会触发 reflow/repaint/composite？

**参考答案：**

```
JS → Style → Layout(Reflow) → Paint(Repaint) → Composite
```

| 操作 | 触发阶段 | 性能代价 |
|------|---------|---------|
| 修改 width/height/margin | Layout → Paint → Composite | 最高 |
| 修改 color/background | Paint → Composite | 中 |
| 修改 transform/opacity | Composite only | 最低（GPU） |
| 读取 offsetWidth | 强制同步 Layout | 高（打断批处理） |

**强制同步布局（Layout Thrashing）：**
```javascript
// 坏：读写交替，每次读都强制 reflow
for (const el of elements) {
  const width = el.offsetWidth;    // 读：强制 reflow
  el.style.width = width + 1 + 'px'; // 写
}

// 好：批量读，批量写
const widths = elements.map(el => el.offsetWidth); // 批量读（一次 reflow）
elements.forEach((el, i) => el.style.width = widths[i] + 1 + 'px'); // 批量写
```

提升为合成层的方式：
```css
.animated {
  will-change: transform; /* 提前提升，避免首帧卡顿 */
  /* 或 */
  transform: translateZ(0); /* hack，不推荐滥用 */
}
```


---

## 五、模块系统与构建

### Q19：ESM 和 CJS 的互操作问题，以及 `package.json` 的 `exports` 字段怎么配

**参考答案：**

核心差异：
- CJS：`require()` 同步，运行时解析，`module.exports` 是值拷贝
- ESM：`import` 静态，编译时分析，导出是实时绑定（live binding）

```json
// package.json：同时支持 ESM 和 CJS（dual package）
{
  "name": "my-lib",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",   // ESM
      "require": "./dist/index.cjs",  // CJS
      "types": "./dist/index.d.ts"
    },
    "./utils": {
      "import": "./dist/utils.mjs",
      "require": "./dist/utils.cjs"
    }
  },
  "main": "./dist/index.cjs",   // 旧版 Node.js fallback
  "module": "./dist/index.mjs", // bundler（webpack/rollup）使用
  "types": "./dist/index.d.ts"
}
```

**Dual Package Hazard（双包危险）：**
```
// 问题：CJS 和 ESM 各自加载一份模块，单例失效
import { store } from 'my-lib';      // ESM 版本的 store
const { store } = require('my-lib'); // CJS 版本的 store（不同实例！）
```

解决：用 `exports` 的 `default` 条件统一入口，或只发布 ESM。

---

### Q20：Tree Shaking 失效的常见原因

**参考答案：**

```javascript
// 1. 有副作用的模块（无法安全删除）
// utils.js
window.VERSION = '1.0'; // 副作用！即使没有 import 也不能删
export function add(a, b) { return a + b; }

// 修复：在 package.json 声明
{ "sideEffects": ["*.css", "./src/polyfills.js"] }
// 或对纯模块声明
{ "sideEffects": false }

// 2. 动态 import（无法静态分析）
const mod = await import(`./${name}`); // name 是变量，无法 tree shake

// 3. CJS 格式（require 是动态的）
const { add } = require('./utils'); // 整个模块都会被打包

// 4. 重新导出时丢失标记
// index.js
export * from './a'; // 如果 a.js 有副作用，整个 a 都会被包含

// 5. Babel 将 class 编译为 ES5 时产生副作用
// 原始 ES6 class 可以 tree shake，编译后的 IIFE 不行
// 修复：@babel/plugin-transform-classes 的 loose 模式，或用 esbuild/swc
```

---

*共 20 题，覆盖 JS 引擎原理、异步、TypeScript 类型系统、CSS 工程化、性能优化、构建工具等高级前端核心考点。*
