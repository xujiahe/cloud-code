# JavaScript 面试题

---

## 数据类型

### Q1：JS 有哪些数据类型？如何判断类型？

基本类型（7种）：`string` `number` `boolean` `null` `undefined` `symbol` `bigint`

引用类型：`object`（包含 Array、Function、Date、RegExp 等）

判断方式：
```javascript
typeof 'str'        // 'string'
typeof 42           // 'number'
typeof null         // 'object'（历史遗留 bug）
typeof undefined    // 'undefined'
typeof []           // 'object'
typeof function(){} // 'function'

// 更准确的判断
Object.prototype.toString.call([])        // '[object Array]'
Object.prototype.toString.call(null)      // '[object Null]'
Object.prototype.toString.call(/reg/)     // '[object RegExp]'

[] instanceof Array   // true（但跨 iframe 失效）
Array.isArray([])     // true（推荐）
```

---

### Q2：`==` 和 `===` 的区别？`==` 的隐式转换规则？

`===` 严格相等，不做类型转换。`==` 会进行隐式类型转换：

```javascript
null == undefined   // true（特殊规定）
null == 0           // false
NaN == NaN          // false（NaN 不等于任何值，包括自身）

// 数字 vs 字符串：字符串转数字
1 == '1'            // true

// 布尔值：先转数字
true == 1           // true
false == 0          // true
'' == false         // true（'' → 0，false → 0）

// 对象 vs 基本类型：对象调用 valueOf/toString
[1] == 1            // true（[1].valueOf() → [1]，toString() → '1'，'1' → 1）
```

实际开发中统一用 `===`，只有判断 `null/undefined` 时可以用 `== null`。

---

### Q3：深拷贝和浅拷贝的区别？如何实现深拷贝？

浅拷贝只复制第一层，嵌套对象仍是引用。深拷贝递归复制所有层级。

```javascript
// 浅拷贝
const shallow = { ...obj };
const shallow2 = Object.assign({}, obj);

// 深拷贝方案

// 1. JSON（简单场景，有局限）
const deep = JSON.parse(JSON.stringify(obj));
// 缺点：不支持 undefined、function、Symbol、Date（变字符串）、循环引用（报错）

// 2. structuredClone（现代浏览器/Node 17+，推荐）
const deep2 = structuredClone(obj);
// 支持 Date、RegExp、Map、Set、循环引用，不支持 function

// 3. 手写（处理特殊情况）
function deepClone(val, map = new WeakMap()) {
  if (val === null || typeof val !== 'object') return val;
  if (map.has(val)) return map.get(val); // 处理循环引用
  if (val instanceof Date) return new Date(val);
  if (val instanceof RegExp) return new RegExp(val);
  const clone = Array.isArray(val) ? [] : {};
  map.set(val, clone);
  for (const key of Reflect.ownKeys(val)) {
    clone[key] = deepClone(val[key], map);
  }
  return clone;
}
```

---

## 作用域与闭包

### Q4：什么是闭包？常见使用场景？

闭包是函数与其词法作用域的组合，函数可以访问定义时所在作用域的变量，即使该作用域已经执行完毕。

```javascript
function counter() {
  let count = 0;
  return {
    increment: () => ++count,
    get: () => count,
  };
}
const c = counter();
c.increment(); // 1
c.get();       // 1，count 被闭包保持
```

常见场景：
- 数据私有化（模块模式）
- 函数工厂（柯里化）
- 防抖/节流
- 缓存（memoize）

常见坑：
```javascript
// 经典问题：循环中的闭包
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0); // 输出 3 3 3
}

// 修复1：用 let（块级作用域）
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 0); // 0 1 2
}

// 修复2：IIFE
for (var i = 0; i < 3; i++) {
  ((j) => setTimeout(() => console.log(j), 0))(i);
}
```

---

### Q5：`var`、`let`、`const` 的区别？

| | 作用域 | 变量提升 | 暂时性死区 | 重复声明 | 可重赋值 |
|--|--------|---------|-----------|---------|---------|
| var | 函数 | 是（初始化为 undefined） | 否 | 是 | 是 |
| let | 块级 | 是（但不初始化） | 是 | 否 | 是 |
| const | 块级 | 是（但不初始化） | 是 | 否 | 否 |

`const` 只保证绑定不变，对象内部属性仍可修改。

---

## 原型与继承

### Q6：原型链是什么？`__proto__` 和 `prototype` 的关系？

每个对象都有 `__proto__` 指向其原型，访问属性时沿原型链向上查找，直到 `null`。

```javascript
function Person(name) { this.name = name; }
Person.prototype.greet = function() { return `Hi, ${this.name}`; };

const p = new Person('Alice');
p.__proto__ === Person.prototype  // true
Person.prototype.__proto__ === Object.prototype // true
Object.prototype.__proto__ === null // true

// new 的过程
function myNew(Fn, ...args) {
  const obj = Object.create(Fn.prototype); // 创建对象，原型指向 Fn.prototype
  const result = Fn.apply(obj, args);       // 执行构造函数
  return result instanceof Object ? result : obj; // 构造函数返回对象则用它
}
```

---

### Q7：ES6 class 和 ES5 构造函数的区别？

```javascript
// ES5
function Animal(name) { this.name = name; }
Animal.prototype.speak = function() { return this.name; };

// ES6 class（语法糖，本质相同）
class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name; } // 定义在 prototype 上
}
```

主要区别：
- class 必须用 `new` 调用，否则报错；构造函数可以直接调用
- class 内部默认严格模式
- class 的方法不可枚举（`enumerable: false`）
- class 不存在变量提升（有暂时性死区）
- 继承：class 用 `extends`，ES5 需要手动设置原型链

---

## 异步

### Q8：Promise 的三种状态和常用方法？

三种状态：`pending` → `fulfilled` / `rejected`，状态一旦改变不可逆。

```javascript
// 常用静态方法
Promise.all([p1, p2, p3])      // 全部成功才成功，一个失败就失败
Promise.allSettled([p1, p2])   // 等所有完成，返回每个结果的状态
Promise.race([p1, p2])         // 第一个完成（无论成功失败）
Promise.any([p1, p2])          // 第一个成功，全部失败才失败

// 链式调用
fetch('/api')
  .then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err))
  .finally(() => setLoading(false));
```

---

### Q9：async/await 的错误处理方式？

```javascript
// 方式1：try/catch
async function fetchUser(id) {
  try {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

// 方式2：封装 to 函数（避免嵌套 try/catch）
const to = (promise) => promise.then(data => [null, data]).catch(err => [err, null]);

async function fetchUser(id) {
  const [err, data] = await to(fetch(`/api/users/${id}`).then(r => r.json()));
  if (err) { /* 处理错误 */ return; }
  return data;
}
```

---

### Q10：手写防抖和节流

```javascript
// 防抖：最后一次触发后延迟执行（搜索输入）
function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 节流：固定时间间隔内只执行一次（滚动、resize）
function throttle(fn, interval) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn.apply(this, args);
    }
  };
}
```

---

## this 指向

### Q11：this 的指向规则？箭头函数的 this 有什么不同？

普通函数的 this 在调用时确定：
- 直接调用：`fn()` → `undefined`（严格模式）或 `window`
- 方法调用：`obj.fn()` → `obj`
- `new` 调用：→ 新创建的对象
- `call/apply/bind` → 指定的对象

箭头函数没有自己的 this，继承定义时所在词法作用域的 this，且无法被 `call/apply/bind` 改变。

```javascript
const obj = {
  name: 'obj',
  regular() { console.log(this.name); },       // 调用时决定
  arrow: () => { console.log(this.name); },    // 定义时决定（这里是全局/undefined）
};

obj.regular(); // 'obj'
obj.arrow();   // undefined（严格模式）

const fn = obj.regular;
fn(); // undefined（丢失 this）
fn.call(obj); // 'obj'
```

---

### Q12：`call`、`apply`、`bind` 的区别？手写 bind

```javascript
fn.call(thisArg, arg1, arg2)    // 立即执行，参数逐个传
fn.apply(thisArg, [arg1, arg2]) // 立即执行，参数数组传
fn.bind(thisArg, arg1)(arg2)    // 返回新函数，可预设参数（柯里化）

// 手写 bind
Function.prototype.myBind = function(thisArg, ...preArgs) {
  const fn = this;
  return function(...args) {
    // 处理 new 调用：new 时 this 是新对象，不应被 bind 覆盖
    if (new.target) {
      return new fn(...preArgs, ...args);
    }
    return fn.apply(thisArg, [...preArgs, ...args]);
  };
};
```

---

## 事件

### Q13：事件冒泡和捕获？事件委托是什么？

事件传播三阶段：捕获（从 window 向下）→ 目标 → 冒泡（向上到 window）

`addEventListener(event, handler, useCapture)`，第三个参数 `true` 为捕获阶段，默认 `false` 为冒泡阶段。

事件委托：把子元素的事件监听绑定到父元素，利用冒泡机制处理。

```javascript
// 不用给每个 li 绑定事件
document.querySelector('ul').addEventListener('click', (e) => {
  if (e.target.tagName === 'LI') {
    console.log(e.target.textContent);
  }
});
```

优点：减少内存占用，动态添加的子元素自动生效。

`e.stopPropagation()` 阻止冒泡，`e.preventDefault()` 阻止默认行为。

---

## 其他

### Q14：`localStorage`、`sessionStorage`、`cookie` 的区别？

| | 大小 | 生命周期 | 随请求发送 | 作用域 |
|--|------|---------|-----------|--------|
| cookie | 4KB | 可设置过期时间 | 是（自动） | 可跨子域 |
| localStorage | 5MB | 永久（手动清除） | 否 | 同源 |
| sessionStorage | 5MB | 标签页关闭即清除 | 否 | 同标签页 |

---

### Q15：什么是事件循环？宏任务和微任务有哪些？

JS 是单线程的，事件循环负责调度异步任务：执行同步代码 → 清空微任务队列 → 执行一个宏任务 → 清空微任务队列 → ...

微任务（优先级高）：`Promise.then/catch/finally`、`queueMicrotask`、`MutationObserver`

宏任务：`setTimeout`、`setInterval`、`setImmediate`（Node）、I/O、UI 渲染

```javascript
console.log('1');
setTimeout(() => console.log('2'), 0);
Promise.resolve().then(() => console.log('3'));
console.log('4');
// 输出：1 4 3 2
```
