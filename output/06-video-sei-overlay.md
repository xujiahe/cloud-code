# Video + Canvas SEI 数据叠加渲染面试题图谱

> 难度范围：⭐⭐⭐ 高级 | 题目数量：6 道 | 更新日期：2025-01

本文档聚焦于**视频流 + Canvas 叠加信息**的工程场景：通过 H.264/H.265 SEI（Supplemental Enhancement Information）通道随帧携带业务数据（目标框、轨迹、热力图等），在 Canvas 上与视频帧精确对齐渲染。这是安防监控、自动驾驶标注、直播互动等领域的高频面试考点。

> 📌 **性能优化基础：** [04-performance.md](./04-performance.md) | **实战应用：** [05-practical-cases.md](./05-practical-cases.md)

---

## 知识点导图

```mermaid
graph TD
    A[Video + Canvas SEI 叠加] --> B[SEI 数据通道]
    A --> C[帧级时间对齐]
    A --> D[Canvas 叠加渲染]
    A --> E[大数据量 SEI 处理]
    A --> F[性能优化]

    B --> B1[H.264 SEI NAL Unit type=6]
    B --> B2[user_data_unregistered type=5]
    B --> B3[MSE 拦截 / WebCodecs]

    C --> C1[PTS 时间戳映射]
    C --> C2[requestVideoFrameCallback]
    C --> C3[SEI 队列与帧同步]

    D --> D1[video + canvas 叠加布局]
    D --> D2[归一化坐标映射]
    D --> D3[分层 Canvas 渲染]

    E --> E1[DataView 二进制解析]
    E --> E2[Worker 线程解析]
    E --> E3[增量更新策略]

    F --> F1[SEI 缓冲队列管理]
    F --> F2[脏矩形局部重绘]
    F --> F3[离屏 Canvas 缓存]
```

---

## Q1. 什么是视频 SEI？如何在 Web 端提取 SEI 数据？

**难度：** ⭐⭐⭐ 高级
**高频标签：** 🔥 字节跳动高频 | 安防/自动驾驶方向

### 考察点

- H.264 SEI NAL Unit 的结构与 `user_data_unregistered` 类型（type=5）
- Web 端提取 SEI 的两种路径：MSE 拦截 vs WebCodecs API
- SEI payload 的二进制解析（`DataView` / `Uint8Array`）
- SEI 数据与视频帧的 PTS 时间戳绑定关系

### 参考答案

**SEI（Supplemental Enhancement Information）** 是 H.264/H.265 标准中的附加信息单元，以 NAL Unit 形式嵌入码流，不影响解码画面，但可携带任意业务数据。

**SEI 类型 5 — `user_data_unregistered`：**

- 最常用的自定义数据通道
- 结构：`[NAL header][SEI type=5][payload size][UUID 16字节][自定义数据]`
- UUID 用于区分不同业务方的数据（防冲突）

**Web 端提取路径对比：**

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| MSE + 拦截 appendBuffer | 在送入 SourceBuffer 前扫描 NALU | 兼容性好（Chrome 34+） | 需手动实现 NALU 解析器 |
| WebCodecs EncodedVideoChunk | 解码前拦截编码帧解析 SEI | API 简洁，性能好 | Chrome 94+，兼容性较差 |
| 服务端提取 + WebSocket 推送 | 服务端解析后与视频流并行推送 | 前端零解析成本 | 需服务端支持，有网络延迟 |

**PTS 时间戳绑定：** SEI 与其所在视频帧共享同一个 PTS（Presentation Timestamp），这是帧级对齐的关键。

### 代码示例

```js
/**
 * 从 H.264 Annex B 码流中提取 SEI NAL Unit
 * start code: 00 00 00 01
 */
const extractSEINALUs = (buffer) => {
  const data = new Uint8Array(buffer);
  const seiUnits = [];
  let i = 0;

  while (i < data.length - 4) {
    // 查找 Annex B start code
    if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
      const naluStart = i + 4;
      const naluType = data[naluStart] & 0x1F; // H.264 NAL unit type

      if (naluType === 6) { // type 6 = SEI
        // 找下一个 start code 确定 NALU 边界
        let naluEnd = data.length;
        for (let j = naluStart + 1; j < data.length - 3; j++) {
          if (data[j] === 0 && data[j+1] === 0 && data[j+2] === 0 && data[j+3] === 1) {
            naluEnd = j; break;
          }
        }
        seiUnits.push(data.slice(naluStart, naluEnd));
      }
      i = naluStart;
    } else {
      i++;
    }
  }
  return seiUnits;
};

/**
 * 解析 SEI NALU，提取 user_data_unregistered (type=5) payload
 */
const parseSEIUserData = (naluBytes) => {
  let offset = 1; // 跳过 NAL header

  while (offset < naluBytes.length) {
    const seiType = naluBytes[offset++];

    // payload size 可能跨多字节（0xFF 表示继续累加）
    let payloadSize = 0;
    while (naluBytes[offset] === 0xFF) payloadSize += naluBytes[offset++];
    payloadSize += naluBytes[offset++];

    if (seiType === 5 && payloadSize >= 16) {
      // 前 16 字节是 UUID
      const uuid = Array.from(naluBytes.slice(offset, offset + 16))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      // UUID 之后是自定义 payload
      const payload = naluBytes.slice(offset + 16, offset + payloadSize);
      return { uuid, payload };
    }
    offset += payloadSize;
  }
  return null;
};

// 拦截 MSE appendBuffer，在送入解码前提取 SEI
// 实际项目中应在 Worker 中执行解析，避免阻塞主线程
const interceptMSEForSEI = (onSEI) => {
  const original = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function(data) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    // 拷贝一份送 Worker 解析，原始 buf 仍送入 MSE
    seiWorker.postMessage({ buffer: buf.slice(0) }, [buf.slice(0)]);
    return original.call(this, data);
  };
};
```

> 💡 **延伸思考：** SEI 解析是 CPU 密集型操作（需要逐字节扫描码流），对于高码率视频（如 4K 60fps）应放在 Web Worker 中执行。解析结果通过 `postMessage` 传回主线程，存入以 PTS 为 key 的有序 Map，等待视频帧回调时查询。

---

## Q2. 如何实现 SEI 数据与视频帧的精确时间对齐？

**难度：** ⭐⭐⭐ 高级
**高频标签：** 🔥 字节跳动高频 | 腾讯高频

### 考察点

- `requestVideoFrameCallback`（rVFC）API 的作用与参数
- rVFC 与 `requestAnimationFrame` 的本质区别
- SEI 队列的设计：以 PTS 为 key 的有序缓冲
- 帧丢失/跳帧场景下的容错处理
- `video.currentTime` 的精度问题

### 参考答案

**核心问题：** `requestAnimationFrame` 触发时机是显示器刷新（约 16ms），而视频帧的实际呈现时机由解码器决定，两者不同步。直接用 rAF + `video.currentTime` 查询 SEI 会有 ±1 帧的误差。

**`requestVideoFrameCallback`（rVFC）：**

- Chrome 83+ 支持，在**每一帧视频实际呈现到屏幕前**触发回调
- `metadata.mediaTime`：该帧的精确 PTS（秒），精度远高于 `video.currentTime`
- `metadata.presentedFrames`：累计呈现帧数，可检测跳帧

**rVFC vs rAF 对比：**

| 维度 | requestAnimationFrame | requestVideoFrameCallback |
|------|----------------------|--------------------------|
| 触发时机 | 显示器刷新（~16ms） | 视频帧实际呈现时 |
| 时间精度 | `performance.now()`，与视频帧无关 | `metadata.mediaTime`，精确到帧 |
| 跳帧检测 | 不支持 | `metadata.presentedFrames` |
| 暂停时触发 | 继续触发 | 不触发 |
| 兼容性 | 全浏览器 | Chrome 83+，Safari 15.4+ |

**SEI 队列设计原则：**

- 以 PTS 为 key 存储，保持有序（便于近似查找）
- 精确匹配优先，容差匹配兜底（容差 = 半帧时长 ≈ 16ms）
- 定期清理过期数据（早于当前播放时间 2 秒的条目）

### 代码示例

```js
class SEIVideoSyncRenderer {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    // SEI 缓冲：Map<pts(秒), seiData>，按 PTS 有序插入
    this.seiBuffer = new Map();
    this._rVFCId = null;
    this._rafId = null;
    this._lastPresentedFrames = 0;
  }

  feedSEI(pts, data) {
    this.seiBuffer.set(pts, data);
    // 清理 2 秒前的过期数据
    const expire = this.video.currentTime - 2;
    for (const [key] of this.seiBuffer) {
      if (key < expire) this.seiBuffer.delete(key);
      else break;
    }
  }

  _findSEI(pts, tolerance = 0.016) {
    if (this.seiBuffer.has(pts)) return this.seiBuffer.get(pts);
    // 近似匹配：找 PTS 差值最小的条目
    let bestKey = null, bestDiff = Infinity;
    for (const [key] of this.seiBuffer) {
      const diff = Math.abs(key - pts);
      if (diff < bestDiff) { bestDiff = diff; bestKey = key; }
      if (key > pts + tolerance) break;
    }
    return bestDiff <= tolerance ? this.seiBuffer.get(bestKey) : null;
  }

  start() {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      // ✅ 精确模式：每帧视频呈现时触发，metadata.mediaTime 是精确 PTS
      const onFrame = (now, metadata) => {
        const seiData = this._findSEI(metadata.mediaTime);

        // 检测跳帧（快进、网络卡顿恢复等场景）
        const skipped = metadata.presentedFrames - this._lastPresentedFrames - 1;
        if (skipped > 0) {
          console.warn(`跳帧 ${skipped} 帧 @ PTS=${metadata.mediaTime.toFixed(3)}s`);
        }
        this._lastPresentedFrames = metadata.presentedFrames;

        this._renderOverlay(seiData, metadata.mediaTime);
        this._rVFCId = this.video.requestVideoFrameCallback(onFrame);
      };
      this._rVFCId = this.video.requestVideoFrameCallback(onFrame);
    } else {
      // ⚠️ 降级：rAF + currentTime，精度约 ±1 帧
      console.warn('rVFC 不支持，降级到 rAF 模式');
      const fallback = () => {
        const seiData = this._findSEI(this.video.currentTime, 0.05);
        this._renderOverlay(seiData, this.video.currentTime);
        this._rafId = requestAnimationFrame(fallback);
      };
      this._rafId = requestAnimationFrame(fallback);
    }
  }

  stop() {
    if (this._rVFCId) this.video.cancelVideoFrameCallback(this._rVFCId);
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  _renderOverlay(seiData, pts) {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    if (!seiData) return;
    seiData.objects?.forEach(obj => this._drawBox(obj));
  }

  _drawBox({ x, y, w, h, label, classId, confidence }) {
    const { width, height } = this.canvas;
    // SEI 坐标为归一化坐标（0~1），映射到 Canvas 像素坐标
    const px = x * width, py = y * height, pw = w * width, ph = h * height;
    const color = `hsl(${classId * 47 % 360}, 80%, 55%)`;
    this.ctx.strokeStyle = color; this.ctx.lineWidth = 2;
    this.ctx.strokeRect(px, py, pw, ph);
    this.ctx.fillStyle = color + 'cc';
    this.ctx.fillRect(px, py - 20, pw, 20);
    this.ctx.fillStyle = '#fff'; this.ctx.font = '11px monospace';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(`${label} ${(confidence * 100).toFixed(0)}%`, px + 4, py - 10);
  }
}
```

> 💡 **延伸思考：** `requestVideoFrameCallback` 在视频暂停时不触发。需要监听 `video.onseeked` 事件，在用户拖动进度条后手动触发一次 Canvas 重绘，确保暂停帧的 SEI 数据也能正确显示。

---

## Q3. SEI 数据量很大且实时更新，如何设计高性能解析与渲染管线？

**难度：** ⭐⭐⭐ 高级
**高频标签：** 🔥 字节跳动高频 | 阿里高频

### 考察点

- Worker 线程解析 SEI 的完整架构
- `Transferable Objects`（ArrayBuffer 所有权转移）避免内存拷贝
- 增量更新策略：只更新变化的目标，而非全量重绘
- 大 SEI payload 的 DataView 二进制解析
- 内存管理：避免 SEI 缓冲无限增长

### 参考答案

**高性能三线程管线架构：**

```
视频码流（MSE appendBuffer）
  ↓ 拦截，零拷贝 transfer ArrayBuffer
SEI Worker：NALU 扫描 → DataView 解析 → postMessage(result)
  ↓
主线程：seiBuffer.set(pts, data)
  ↓ requestVideoFrameCallback
渲染：seiBuffer.query(pts) → Canvas 增量绘制
  ↓（热力图场景）
Render Worker：OffscreenCanvas 渲染 → transferToImageBitmap()
  ↓ 主线程 drawImage(bitmap)
```

**关键优化点：**

1. **零拷贝传输**：`postMessage(buf, [buf])` 转移 ArrayBuffer 所有权，避免 O(n) 内存拷贝
2. **增量更新**：对比前后帧目标列表，只重绘坐标/置信度发生变化的目标
3. **分层 Canvas**：视频层（`<video>`）+ 叠加层（`<canvas>`），每帧只清除叠加层
4. **批量绘制**：同类型图形合并为一条路径，减少 Canvas 状态切换
5. **对象池**：复用目标框对象，减少 GC 压力

### 代码示例

```js
// ── SEI 解析 Worker（sei-worker.js）──
self.onmessage = ({ data: { buffer, pts } }) => {
  const result = parseSEIPayload(new Uint8Array(buffer));
  if (result) self.postMessage({ pts, data: result });
};

const parseSEIPayload = (bytes) => {
  // 跳过 NAL header(1) + SEI type(1) + size(1+) + UUID(16)
  let offset = 1;
  const seiType = bytes[offset++];
  let payloadSize = 0;
  while (bytes[offset] === 0xFF) payloadSize += bytes[offset++];
  payloadSize += bytes[offset++];
  if (seiType !== 5 || payloadSize < 16) return null;
  offset += 16; // 跳过 UUID

  // 使用 DataView 解析二进制结构体（注意字节序）
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
  let pos = 0;

  const version    = view.getUint16(pos, false); pos += 2;  // 大端序
  const timestamp  = view.getFloat64(pos, true);  pos += 8;  // 小端序
  const objCount   = view.getUint16(pos, false);  pos += 2;

  const objects = [];
  for (let i = 0; i < objCount; i++) {
    objects.push({
      id:         view.getUint32(pos, false),              pos += 4,
      classId:    view.getUint8(pos++),
      confidence: view.getUint8(pos++) / 255,              // 归一化 0~1
      x:          view.getUint16(pos, false) / 65535,      pos += 2, // 归一化坐标
      y:          view.getUint16(pos, false) / 65535,      pos += 2,
      w:          view.getUint16(pos, false) / 65535,      pos += 2,
      h:          view.getUint16(pos, false) / 65535,      pos += 2,
    });
  }
  return { version, timestamp, objects };
};

// ── 主线程：增量更新渲染器 ──
class IncrementalOverlayRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._prev = new Map(); // id → object（上一帧）
  }

  update(newObjects) {
    const next = new Map(newObjects.map(o => [o.id, o]));
    // 检查是否有变化（避免无意义重绘）
    let changed = next.size !== this._prev.size;
    if (!changed) {
      for (const [id, obj] of next) {
        const p = this._prev.get(id);
        if (!p || Math.abs(obj.x - p.x) > 0.001 || Math.abs(obj.y - p.y) > 0.001) {
          changed = true; break;
        }
      }
    }
    if (!changed) return;

    this._prev = next;
    this._render(newObjects);
  }

  _render(objects) {
    const { width: W, height: H } = this.canvas;
    this.ctx.clearRect(0, 0, W, H);

    // 按 classId 分组，批量绘制同类型目标框（减少 strokeStyle 切换）
    const groups = new Map();
    objects.forEach(o => {
      if (!groups.has(o.classId)) groups.set(o.classId, []);
      groups.get(o.classId).push(o);
    });

    groups.forEach((objs, classId) => {
      const color = `hsl(${classId * 47 % 360}, 80%, 55%)`;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2;
      // 同类型所有矩形合并为一条路径
      this.ctx.beginPath();
      objs.forEach(({ x, y, w, h }) => {
        this.ctx.rect(x * W, y * H, w * W, h * H);
      });
      this.ctx.stroke();
      // 标签单独绘制
      objs.forEach(obj => this._drawLabel(obj, color, W, H));
    });
  }

  _drawLabel({ x, y, w, label, confidence }, color, W, H) {
    const px = x * W, py = y * H, pw = w * W;
    this.ctx.fillStyle = color + 'cc';
    this.ctx.fillRect(px, py - 18, Math.min(pw, 100), 18);
    this.ctx.fillStyle = '#fff';
    this.ctx.font = '11px monospace';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(`${label} ${(confidence * 100).toFixed(0)}%`, px + 3, py - 9);
  }
}
```

> 💡 **延伸思考：** 当 SEI 数据包含热力图（每帧一张 64×64 概率矩阵）时，数据量可达数十 KB/帧。应在 Worker 中将矩阵渲染到 `OffscreenCanvas`，通过 `transferToImageBitmap()` 传回主线程，主线程只需一次 `drawImage` 完成热力图叠加，避免主线程处理大量像素数据。

---

## Q4. video + canvas 叠加的布局方案与坐标系归一化

**难度：** ⭐⭐ 中级
**高频标签：** 🔥 阿里高频 | 美团高频

### 考察点

- video 与 canvas 叠加的 CSS 布局方案
- `object-fit: contain` 导致的黑边问题与坐标偏移计算
- SEI 归一化坐标（0~1）到 Canvas 像素坐标的映射
- 视频分辨率与 Canvas 尺寸不一致时的缩放处理
- 响应式布局下的坐标重新计算

### 参考答案

**叠加布局方案：**

```html
<div class="video-container">
  <video id="video"></video>
  <canvas id="overlay"></canvas>  <!-- 绝对定位，覆盖在 video 上 -->
</div>
```

```css
.video-container { position: relative; }
video, canvas {
  position: absolute; top: 0; left: 0;
  width: 100%; height: 100%;
}
canvas { pointer-events: none; } /* 鼠标事件穿透到 video */
```

**`object-fit: contain` 的黑边问题：**

当视频宽高比与容器不一致时，`object-fit: contain` 会在两侧或上下产生黑边。SEI 坐标是相对于**视频内容区域**的，而 Canvas 坐标是相对于**容器**的，需要计算实际视频渲染区域的偏移和缩放比。

**归一化坐标的优势：** SEI 中存储归一化坐标（0~1）而非像素坐标，使得同一份 SEI 数据可以适配任意分辨率的播放器，无需随分辨率变化重新编码。

### 代码示例

```js
/**
 * 计算 video 在容器中的实际渲染区域
 * 处理 object-fit: contain 产生的黑边偏移
 */
const getVideoRenderRect = (video) => {
  const cW = video.clientWidth, cH = video.clientHeight;
  const vW = video.videoWidth,  vH = video.videoHeight;
  if (!vW || !vH) return { offsetX: 0, offsetY: 0, renderW: cW, renderH: cH };

  // contain 模式：取较小缩放比，保持宽高比
  const scale = Math.min(cW / vW, cH / vH);
  const renderW = vW * scale, renderH = vH * scale;
  // 居中对齐产生的黑边偏移
  const offsetX = (cW - renderW) / 2;
  const offsetY = (cH - renderH) / 2;
  return { offsetX, offsetY, renderW, renderH };
};

/**
 * SEI 归一化坐标 → Canvas 像素坐标
 * 同时处理 object-fit 黑边偏移和 DPR 缩放
 */
const seiToCanvas = (nx, ny, video, canvas) => {
  const { offsetX, offsetY, renderW, renderH } = getVideoRenderRect(video);
  // Canvas 物理像素与容器 CSS 像素的比值（DPR 适配）
  const dprScale = canvas.width / video.clientWidth;
  return {
    x: (offsetX + nx * renderW) * dprScale,
    y: (offsetY + ny * renderH) * dprScale,
  };
};

/**
 * 同步 Canvas 尺寸到 video 容器（含 DPR 高清适配）
 */
const syncCanvasToVideo = (video, canvas) => {
  const dpr = window.devicePixelRatio || 1;
  const w = video.clientWidth, h = video.clientHeight;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.getContext('2d').scale(dpr, dpr);
};

// 响应式：监听容器尺寸变化
const ro = new ResizeObserver(() => {
  syncCanvasToVideo(video, overlayCanvas);
  renderer.forceRedraw(); // 用新坐标映射重绘
});
ro.observe(video);
```

> 💡 **延伸思考：** 如果视频使用 `object-fit: cover`（裁剪模式），缩放比改为取较大值，并计算裁剪偏移（负值）。建议将坐标映射逻辑封装为独立函数，通过 `objectFit` 参数控制行为，方便在不同播放器场景下复用。

---

## Q5. 如何处理 SEI 数据丢失、乱序、网络抖动等异常场景？

**难度：** ⭐⭐⭐ 高级
**高频标签：** 🔥 字节跳动高频 | 腾讯高频

### 考察点

- SEI 数据丢失时的降级策略（保持上一帧 vs 清空）
- 乱序 SEI 的排序与去重处理
- 网络抖动导致 SEI 与视频帧时间差过大的检测
- 播放器 seek/跳转后 SEI 缓冲的清理
- 直播场景下的低延迟 SEI 同步策略

### 参考答案

**异常场景分类与处理策略：**

| 场景 | 原因 | 处理策略 |
|------|------|---------|
| SEI 丢失 | 网络丢包、编码器未插入 | 保持上一帧（≤3帧），超过后清空叠加层 |
| SEI 乱序 | 网络重传、多路流合并 | 按 PTS 排序插入，丢弃 PTS < currentTime-1s 的过期包 |
| 时间差过大 | 网络抖动、解码延迟 | 设置最大容差（200ms），超出则不渲染 |
| seek 跳转 | 用户拖动进度条 | 清空 SEI 缓冲，等待新数据 |
| 直播低延迟 | 缓冲区小，SEI 可能超前 | SEI 超前时等待视频帧追上；视频超前时立即渲染最近 SEI |

### 代码示例

```js
class RobustSEIBuffer {
  constructor({ maxAge = 3, maxTolerance = 0.2, maxMissingFrames = 5 } = {}) {
    this.maxAge = maxAge;
    this.maxTolerance = maxTolerance;
    this.maxMissingFrames = maxMissingFrames;
    this._buffer = new Map();
    this._lastValidPts = -1;
    this._missingCount = 0;
    this._lastData = null;
  }

  insert(pts, data) {
    // 丢弃明显乱序的过期包（早于上次有效 PTS 超过 1 秒）
    if (pts < this._lastValidPts - 1) {
      console.warn(`丢弃乱序 SEI: pts=${pts.toFixed(3)}`);
      return;
    }
    this._buffer.set(pts, data);
    this._cleanup();
  }

  query(videoPts) {
    // 精确匹配
    if (this._buffer.has(videoPts)) return this._hit(videoPts);

    // 近似匹配
    let bestKey = null, bestDiff = Infinity;
    for (const [key] of this._buffer) {
      const diff = Math.abs(key - videoPts);
      if (diff < bestDiff && diff <= this.maxTolerance) {
        bestDiff = diff; bestKey = key;
      }
    }
    if (bestKey !== null) return this._hit(bestKey);

    // 未匹配：处理丢失
    return this._miss();
  }

  _hit(pts) {
    const data = this._buffer.get(pts);
    this._lastValidPts = pts;
    this._missingCount = 0;
    this._lastData = data;
    return { data, status: 'hit' };
  }

  _miss() {
    this._missingCount++;
    if (this._missingCount <= this.maxMissingFrames) {
      // 短暂丢失：保持上一帧，避免闪烁
      return { data: this._lastData, status: 'hold', count: this._missingCount };
    }
    this._lastData = null;
    return { data: null, status: 'clear' };
  }

  onSeek() {
    // seek 后清空所有缓冲，避免旧数据污染新位置
    this._buffer.clear();
    this._lastValidPts = -1;
    this._missingCount = 0;
    this._lastData = null;
  }

  _cleanup() {
    const expire = this._lastValidPts - this.maxAge;
    for (const [key] of this._buffer) {
      if (key < expire) this._buffer.delete(key);
      else break;
    }
  }
}

// 使用示例
const seiBuffer = new RobustSEIBuffer({ maxTolerance: 0.1, maxMissingFrames: 3 });
video.addEventListener('seeked', () => seiBuffer.onSeek());

video.requestVideoFrameCallback((now, { mediaTime }) => {
  const { data, status, count } = seiBuffer.query(mediaTime);
  if (status === 'hit')  renderer.render(data);
  else if (status === 'hold') renderer.renderWithWarning(data, `SEI 延迟 ${count} 帧`);
  else renderer.clear();
});
```

> 💡 **延伸思考：** 在直播场景下，SEI 数据可能比视频帧**超前**到达（SEI 解析比视频解码快）。此时不应立即渲染，而是将 SEI 存入缓冲，等待对应视频帧呈现时再渲染。需要特别注意缓冲区大小控制，避免直播延迟累积。

---

## Q6. 完整架构设计：高并发 SEI + Canvas 叠加渲染系统

**难度：** ⭐⭐⭐ 高级
**高频标签：** 🔥 字节跳动高频 | 阿里高频

### 分析

在安防监控、自动驾驶标注等场景中，SEI 数据可能包含数百个目标框、轨迹点、语义分割掩码，每帧数据量达数十 KB，且需要 30fps 实时渲染。如何设计一个既保证帧级对齐又保证高性能的完整系统？

### 方案设计

**整体架构（三线程模型）：**

```
┌─────────────────────────────────────────────────────┐
│  主线程                                              │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ MSE/HLS  │───▶│ SEI 缓冲队列 │◀───│ rVFC 回调 │  │
│  │ 视频播放  │    │ (PTS → data) │    │ Canvas 渲染│  │
│  └──────────┘    └──────────────┘    └───────────┘  │
│       │ ArrayBuffer transfer（零拷贝）               │
└───────┼─────────────────────────────────────────────┘
        ↓
┌───────────────────┐
│  SEI Worker       │
│  NALU 扫描        │
│  DataView 解析    │
│  → postMessage    │
└───────────────────┘
        ↓（热力图/掩码场景）
┌───────────────────┐
│  Render Worker    │
│  OffscreenCanvas  │
│  热力图渲染       │
│  → ImageBitmap    │
└───────────────────┘
```

**各层职责划分：**

| 线程 | 职责 | 不做什么 |
|------|------|---------|
| 主线程 | 视频播放、rVFC 回调、Canvas 绘制、用户交互 | 不做 SEI 解析 |
| SEI Worker | NALU 扫描、DataView 解析、JSON 序列化 | 不操作 DOM |
| Render Worker | 热力图/掩码的 OffscreenCanvas 渲染 | 不做业务逻辑 |

### 关键代码

```js
class VideoSEIOverlaySystem {
  constructor(videoEl, overlayCanvas) {
    this.video = videoEl;
    this.canvas = overlayCanvas;

    // SEI 解析 Worker
    this.seiWorker = new Worker('./sei-worker.js', { type: 'module' });
    this.seiWorker.onmessage = ({ data: { pts, data } }) => {
      this.seiBuffer.insert(pts, data);
    };

    this.seiBuffer = new RobustSEIBuffer({ maxTolerance: 0.1, maxMissingFrames: 3 });
    this.renderer = new IncrementalOverlayRenderer(overlayCanvas);

    this._interceptMSE();
    this._syncSize();
    new ResizeObserver(() => this._syncSize()).observe(videoEl);
    videoEl.addEventListener('seeked', () => this.seiBuffer.onSeek());
  }

  _interceptMSE() {
    const self = this;
    const original = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function(data) {
      const buf = data instanceof ArrayBuffer ? data : data.buffer;
      // 拷贝一份送 Worker（原始 buf 仍需送入 MSE 解码）
      const copy = buf.slice(0);
      self.seiWorker.postMessage({ buffer: copy }, [copy]); // 零拷贝 transfer
      return original.call(this, data);
    };
  }

  _syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.video.clientWidth, h = this.video.clientHeight;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.getContext('2d').scale(dpr, dpr);
  }

  start() {
    const tick = (now, metadata) => {
      const { data, status } = this.seiBuffer.query(metadata.mediaTime);
      const rect = getVideoRenderRect(this.video); // 处理 object-fit 黑边

      if (status !== 'clear' && data) {
        this.renderer.update(data.objects ?? [], rect);
      } else if (status === 'clear') {
        this.renderer.clear();
      }

      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  destroy() {
    this.seiWorker.terminate();
  }
}
```

> 💡 **延伸思考：** 当需要同时渲染多路视频（如监控大屏 16 路）时，应共享一个 SEI Worker 线程池（而非每路视频一个 Worker），通过 `videoId` 区分不同路的数据，避免线程数量爆炸。线程池大小建议为 `navigator.hardwareConcurrency / 2`，为主线程和渲染线程保留足够资源。

---

## 延伸阅读

- [MDN — requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) — 帧级回调 API，含 metadata 参数详细说明与兼容性数据
- [W3C — Video Frame Callback Spec](https://wicg.github.io/video-rvfc/) — rVFC 规范草案，了解 mediaTime 精度保证
- [MDN — WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) — 编解码帧级访问，可用于提取 SEI
- [MDN — Media Source Extensions](https://developer.mozilla.org/zh-CN/docs/Web/API/Media_Source_Extensions_API) — MSE 完整文档，理解 appendBuffer 拦截原理
- [ITU-T H.264 规范](https://www.itu.int/rec/T-REC-H.264) — SEI 定义在 Annex D，user_data_unregistered 在 D.2.7
- [OffscreenCanvas — MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) — Worker 中渲染热力图的基础

---

> 📌 **文档导航：**
> - 返回：[index.md — 总索引](./index.md)
> - 相关：[04-performance.md — 性能优化专题](./04-performance.md)
> - 相关：[05-practical-cases.md — 实战应用专题](./05-practical-cases.md)
