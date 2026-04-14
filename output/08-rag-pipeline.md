# RAG 全链路面试题图谱

> 覆盖 Indexing Pipeline、检索优化、重排序、上下文组装到异常降级的完整知识体系

---

## Q1. RAG 整体架构与数据流 ⭐⭐

**高频标签**：`系统设计` `架构` `数据流`

**考察点**
- Indexing Pipeline vs Query Pipeline 的职责划分
- 各阶段的典型延迟分布
- Naive RAG → Advanced RAG → Modular RAG 的演进脉络

### 参考答案

RAG 系统由两条相互独立的流水线组成：

**Indexing Pipeline（离线）**
```
原始文档 → 解析（PDF/HTML/代码）→ 分块（Chunking）→ 向量化（Embedding）→ 写入向量数据库
```
这条流水线是异步的，通常由定时任务或事件触发，延迟不敏感。

**Query Pipeline（在线）**
```
用户查询 → 查询改写 → 向量检索 + 稀疏检索 → 融合排序 → 重排序 → 上下文组装 → LLM 生成
```

**各阶段典型延迟（P50，生产环境）**

| 阶段 | 延迟 | 瓶颈 |
|------|------|------|
| 查询向量化 | 5–20ms | 模型推理 |
| ANN 检索 | 2–10ms | 索引结构 |
| 重排序（Cross-Encoder） | 50–200ms | 模型推理 |
| LLM 生成（首 token） | 200–800ms | 网络+推理 |

**三代 RAG 演进**

- **Naive RAG**：固定分块 → 单路向量检索 → 直接拼接 → 生成。问题：语义鸿沟、上下文噪声。
- **Advanced RAG**：引入查询改写、混合检索、重排序、滑动窗口分块。
- **Modular RAG**：将各模块解耦为可插拔组件（检索器、重排器、生成器），支持路由、自适应检索、迭代式 RAG（FLARE）。

### 延伸思考
- 如何在 Query Pipeline 中实现流式输出（Streaming）同时保持引用追踪？
- Agentic RAG 与 Modular RAG 的边界在哪里？

---

## Q2. 文档解析与分块策略 ⭐⭐⭐

**高频标签**：`文档处理` `分块` `工程实践`

**考察点**
- 不同文档类型的解析挑战
- 分块策略对比与选型
- chunk size / overlap 的权衡

### 参考答案

**文档解析挑战**

| 类型 | 挑战 | 推荐工具 |
|------|------|----------|
| PDF | 布局还原、跨列文本、表格结构、嵌入图片 | PyMuPDF、pdfplumber、Unstructured |
| HTML | 导航栏/广告噪声、动态渲染内容 | BeautifulSoup + Readability |
| 代码文件 | 语义边界是函数/类而非句子 | Tree-sitter AST 分割 |
| 扫描件 | 需要 OCR，且 OCR 错误会污染向量 | Tesseract + 置信度过滤 |

**分块策略对比**

| 策略 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 固定大小 | 按 token 数截断 | 简单、可预测 | 切断语义单元 |
| 句子级 | 按句号/换行分割 | 语义完整 | 块大小不均匀 |
| 语义级 | 相邻句子嵌入相似度跌落处分割 | 语义边界准确 | 计算开销大 |
| 递归分块 | 按段落→句子→词语递归尝试 | 兼顾结构与大小 | 实现复杂 |

**chunk size vs overlap 权衡**
- chunk 过小（< 128 tokens）：上下文不足，LLM 无法推理
- chunk 过大（> 1024 tokens）：噪声多，检索精度下降，且占用 context window
- overlap 过大：冗余信息增加存储和检索成本
- 经验值：512 tokens + 64 tokens overlap，对大多数场景是合理起点

### 代码示例：递归语义分块器（Python）


```python
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import List, Optional
import numpy as np

@dataclass
class Chunk:
    text: str
    start_char: int
    end_char: int
    metadata: dict

class RecursiveSemanticChunker:
    """
    先按结构分隔符递归分割，再用语义相似度合并过小的块。
    边界处理：保证每个 chunk 不超过 max_tokens，且不在单词中间截断。
    """

    SEPARATORS = ["\n\n", "\n", "。", ".", " ", ""]

    def __init__(
        self,
        max_tokens: int = 512,
        overlap_tokens: int = 64,
        min_tokens: int = 64,
        embed_fn=None,          # 可选：传入 embedding 函数做语义合并
        semantic_threshold: float = 0.85,
    ):
        self.max_tokens = max_tokens
        self.overlap_tokens = overlap_tokens
        self.min_tokens = min_tokens
        self.embed_fn = embed_fn
        self.semantic_threshold = semantic_threshold

    def _token_count(self, text: str) -> int:
        # 简化估算：中文按字符，英文按空格分词
        chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
        english_words = len(re.findall(r'[a-zA-Z]+', text))
        return chinese + english_words

    def _split_by_separator(self, text: str, sep: str) -> List[str]:
        if sep == "":
            # 最后兜底：按 max_tokens 强制截断，不在单词中间断开
            chunks, i = [], 0
            words = text.split(" ")
            current, current_len = [], 0
            for word in words:
                wlen = self._token_count(word)
                if current_len + wlen > self.max_tokens and current:
                    chunks.append(" ".join(current))
                    # overlap：保留最后 overlap_tokens 的词
                    overlap_words = []
                    overlap_len = 0
                    for w in reversed(current):
                        if overlap_len + self._token_count(w) > self.overlap_tokens:
                            break
                        overlap_words.insert(0, w)
                        overlap_len += self._token_count(w)
                    current = overlap_words + [word]
                    current_len = overlap_len + wlen
                else:
                    current.append(word)
                    current_len += wlen
            if current:
                chunks.append(" ".join(current))
            return chunks
        return text.split(sep)

    def _recursive_split(self, text: str, sep_index: int = 0) -> List[str]:
        if self._token_count(text) <= self.max_tokens:
            return [text] if text.strip() else []

        if sep_index >= len(self.SEPARATORS):
            return [text]  # 无法继续分割，直接返回

        sep = self.SEPARATORS[sep_index]
        parts = self._split_by_separator(text, sep)

        result = []
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if self._token_count(part) > self.max_tokens:
                # 当前分隔符不够细，递归用下一级
                result.extend(self._recursive_split(part, sep_index + 1))
            else:
                result.append(part)
        return result

    def _merge_small_chunks(self, chunks: List[str]) -> List[str]:
        """将过小的 chunk 与相邻块合并，避免碎片化"""
        if not chunks:
            return []
        merged, buffer = [], chunks[0]
        for chunk in chunks[1:]:
            combined = buffer + " " + chunk
            if self._token_count(combined) <= self.max_tokens:
                buffer = combined
            else:
                if self._token_count(buffer) >= self.min_tokens:
                    merged.append(buffer)
                else:
                    # buffer 太小，强制合并到下一个（即使超限也优先保语义完整）
                    buffer = combined
                    continue
                buffer = chunk
        if buffer.strip():
            merged.append(buffer)
        return merged

    def _semantic_merge(self, chunks: List[str]) -> List[str]:
        """可选：用 embedding 相似度合并语义连续的相邻小块"""
        if self.embed_fn is None or len(chunks) < 2:
            return chunks

        embeddings = self.embed_fn(chunks)  # shape: (N, D)
        result, i = [], 0
        while i < len(chunks):
            if i + 1 < len(chunks):
                sim = float(np.dot(embeddings[i], embeddings[i+1]) /
                            (np.linalg.norm(embeddings[i]) * np.linalg.norm(embeddings[i+1]) + 1e-9))
                combined = chunks[i] + " " + chunks[i+1]
                if sim >= self.semantic_threshold and self._token_count(combined) <= self.max_tokens:
                    chunks[i+1] = combined  # 合并到下一个继续判断
                    i += 1
                    continue
            result.append(chunks[i])
            i += 1
        return result

    def chunk(self, text: str, metadata: Optional[dict] = None) -> List[Chunk]:
        if not text or not text.strip():
            return []

        raw_chunks = self._recursive_split(text)
        raw_chunks = self._merge_small_chunks(raw_chunks)
        raw_chunks = self._semantic_merge(raw_chunks)

        result, offset = [], 0
        for chunk_text in raw_chunks:
            start = text.find(chunk_text, offset)
            if start == -1:
                start = offset  # 找不到时用当前偏移（合并后文本可能有变化）
            end = start + len(chunk_text)
            result.append(Chunk(
                text=chunk_text,
                start_char=start,
                end_char=end,
                metadata=metadata or {},
            ))
            offset = max(end - self._token_count_chars(self.overlap_tokens), start)
        return result

    def _token_count_chars(self, tokens: int) -> int:
        return tokens * 4  # 粗略估算：1 token ≈ 4 字符
```

### 延伸思考
- 对于代码文件，如何用 Tree-sitter 按函数/类边界分块？
- 表格内容应该序列化为 Markdown 还是 JSON 再向量化？

---

## Q3. 向量化（Embedding）的选型与工程实践 ⭐⭐

**高频标签**：`Embedding` `混合检索` `性能优化`

**考察点**
- 稠密向量 vs 稀疏向量 vs 混合检索
- 模型选型指标
- 批量向量化的性能优化

### 参考答案

**稠密 vs 稀疏 vs 混合**

| 方式 | 原理 | 优势 | 劣势 |
|------|------|------|------|
| 稠密向量（Dense） | 神经网络编码为连续向量 | 语义理解强 | 词汇外（OOV）问题 |
| 稀疏向量（BM25/SPLADE） | TF-IDF 权重稀疏表示 | 精确词匹配、可解释 | 无语义泛化 |
| 混合检索 | 两路结果用 RRF 融合 | 兼顾语义与精确匹配 | 系统复杂度增加 |

**模型选型指标**
- **MTEB 榜单**（Massive Text Embedding Benchmark）：覆盖检索、分类、聚类等 56 个任务，是选型的首要参考
- **领域适配**：通用模型（text-embedding-3-large、BGE-M3）在专业领域（医疗、法律、代码）可能不如领域微调模型
- **向量维度**：维度越高精度越好，但存储和检索成本线性增长；Matryoshka 表示学习（MRL）允许截断维度
- **最大序列长度**：超过限制的文本会被截断，需与分块策略配合

**批量向量化优化**
- 批处理（Batching）：将多个文本打包为一个请求，GPU 利用率从 20% 提升到 80%+
- 异步并发：使用 `asyncio` + 信号量控制并发数，避免 OOM
- 缓存：对相同文本的向量结果缓存（Redis/内存），索引阶段重复文档命中率可达 30%+

### 代码示例：带缓存和批处理的 Embedding 服务（Python）


```python
import asyncio
import hashlib
import json
import time
from typing import List, Optional
import numpy as np

class EmbeddingService:
    """
    生产级 Embedding 服务：支持批处理、异步并发、LRU 缓存、重试。
    """

    def __init__(
        self,
        model_name: str = "text-embedding-3-small",
        batch_size: int = 64,
        max_concurrency: int = 8,
        cache_size: int = 10_000,
        retry_times: int = 3,
    ):
        self.model_name = model_name
        self.batch_size = batch_size
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self.cache: dict[str, list[float]] = {}  # 简化版 LRU，生产用 cachetools.LRUCache
        self.cache_size = cache_size
        self.retry_times = retry_times
        self._stats = {"cache_hit": 0, "cache_miss": 0, "api_calls": 0}

    def _cache_key(self, text: str) -> str:
        return hashlib.sha256(f"{self.model_name}:{text}".encode()).hexdigest()

    def _evict_if_needed(self):
        if len(self.cache) >= self.cache_size:
            # 简单策略：删除最早插入的 10%
            keys_to_delete = list(self.cache.keys())[:self.cache_size // 10]
            for k in keys_to_delete:
                del self.cache[k]

    async def _embed_batch_with_retry(self, texts: List[str]) -> List[List[float]]:
        """调用实际 API，含指数退避重试"""
        import openai  # 延迟导入，避免强依赖
        client = openai.AsyncOpenAI()

        for attempt in range(self.retry_times):
            try:
                async with self.semaphore:
                    self._stats["api_calls"] += 1
                    response = await client.embeddings.create(
                        model=self.model_name,
                        input=texts,
                        encoding_format="float",
                    )
                    return [item.embedding for item in response.data]
            except openai.RateLimitError:
                wait = 2 ** attempt
                await asyncio.sleep(wait)
            except openai.APIError as e:
                if attempt == self.retry_times - 1:
                    raise
                await asyncio.sleep(1)
        raise RuntimeError(f"Embedding API failed after {self.retry_times} retries")

    async def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """
        主入口：先查缓存，未命中的批量请求 API，结果写回缓存。
        保持输入顺序。
        """
        if not texts:
            return []

        results: List[Optional[List[float]]] = [None] * len(texts)
        uncached_indices: List[int] = []
        uncached_texts: List[str] = []

        # 1. 查缓存
        for i, text in enumerate(texts):
            key = self._cache_key(text)
            if key in self.cache:
                results[i] = self.cache[key]
                self._stats["cache_hit"] += 1
            else:
                uncached_indices.append(i)
                uncached_texts.append(text)
                self._stats["cache_miss"] += 1

        # 2. 批量请求未命中的文本
        if uncached_texts:
            batches = [
                uncached_texts[i:i + self.batch_size]
                for i in range(0, len(uncached_texts), self.batch_size)
            ]
            # 并发执行所有批次
            batch_results = await asyncio.gather(
                *[self._embed_batch_with_retry(batch) for batch in batches]
            )
            flat_results = [emb for batch in batch_results for emb in batch]

            # 3. 写回缓存并填充结果
            self._evict_if_needed()
            for idx, (orig_i, emb) in enumerate(zip(uncached_indices, flat_results)):
                key = self._cache_key(uncached_texts[idx])
                self.cache[key] = emb
                results[orig_i] = emb

        return results  # type: ignore

    def get_stats(self) -> dict:
        total = self._stats["cache_hit"] + self._stats["cache_miss"]
        hit_rate = self._stats["cache_hit"] / total if total > 0 else 0
        return {**self._stats, "cache_hit_rate": f"{hit_rate:.1%}"}
```

### 延伸思考
- Matryoshka Representation Learning（MRL）如何在不重新训练的情况下降低向量维度？
- 对于多语言场景，BGE-M3 的 multi-lingual 能力与 OpenAI text-embedding-3 相比如何？

---

## Q4. 向量数据库的选型与索引原理 ⭐⭐⭐

**高频标签**：`向量数据库` `ANN` `索引` `元数据过滤`

**考察点**
- HNSW vs IVF-PQ vs FLAT 的原理与适用场景
- ANN 精度-速度权衡
- 元数据过滤的实现原理

### 参考答案

**三种主流索引对比**

| 索引 | 原理 | 查询复杂度 | 内存占用 | 适用场景 |
|------|------|-----------|---------|---------|
| FLAT | 暴力全量扫描 | O(N·D) | 高（原始向量） | N < 100K，要求精确召回 |
| IVF-PQ | 倒排聚类 + 乘积量化压缩 | O(N/nlist · D/8) | 低（量化压缩） | 亿级向量，内存受限 |
| HNSW | 分层可导航小世界图 | O(log N) | 中（图结构） | 百万级，低延迟优先 |

**HNSW 核心原理**
- 构建多层图，底层包含所有节点，上层是稀疏的"高速公路"
- 查询时从顶层入口节点开始贪心搜索，逐层下降
- 参数 `M`（每节点最大连接数）和 `ef_construction`（构建时搜索宽度）控制精度-速度权衡
- 增量插入友好，但删除节点需要标记删除（lazy deletion）

**元数据过滤的实现原理**
- **Pre-filtering**：先用元数据过滤缩小候选集，再做 ANN 检索。问题：候选集过小时 ANN 退化为 FLAT
- **Post-filtering**：先 ANN 检索 top-K×10，再用元数据过滤。问题：过滤率高时召回不足
- **In-filtering（推荐）**：Qdrant/Weaviate 的实现，在 HNSW 图遍历过程中跳过不满足条件的节点，兼顾效率和召回

### 代码示例：带元数据过滤的混合检索（Python + Qdrant）


```python
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, FieldCondition, Filter, MatchValue,
    NamedSparseVector, NamedVector, QueryRequest,
    SparseVector, VectorParams, SparseVectorParams,
)

@dataclass
class SearchResult:
    id: str
    score: float
    text: str
    metadata: Dict[str, Any]

class HybridSearcher:
    """
    混合检索：稠密向量（HNSW）+ 稀疏向量（BM25/SPLADE）+ 元数据过滤
    使用 Qdrant 的 Query API 在服务端完成 RRF 融合，减少网络传输。
    """

    DENSE_VECTOR_NAME = "dense"
    SPARSE_VECTOR_NAME = "sparse"

    def __init__(self, client: QdrantClient, collection_name: str):
        self.client = client
        self.collection = collection_name

    def _build_filter(self, filters: Optional[Dict[str, Any]]) -> Optional[Filter]:
        """将 dict 格式的过滤条件转换为 Qdrant Filter 对象"""
        if not filters:
            return None
        conditions = []
        for key, value in filters.items():
            if isinstance(value, list):
                # IN 查询：匹配列表中任意值
                from qdrant_client.models import MatchAny
                conditions.append(FieldCondition(key=key, match=MatchAny(any=value)))
            elif isinstance(value, dict) and ("gte" in value or "lte" in value):
                # 范围查询
                from qdrant_client.models import Range
                conditions.append(FieldCondition(
                    key=key,
                    range=Range(gte=value.get("gte"), lte=value.get("lte"))
                ))
            else:
                conditions.append(FieldCondition(key=key, match=MatchValue(value=value)))
        return Filter(must=conditions)

    async def search(
        self,
        dense_vector: List[float],
        sparse_indices: List[int],
        sparse_values: List[float],
        top_k: int = 10,
        filters: Optional[Dict[str, Any]] = None,
        rrf_k: int = 60,
    ) -> List[SearchResult]:
        """
        在 Qdrant 服务端执行混合检索 + RRF 融合。
        filters 示例：{"source": "docs", "year": {"gte": 2023}}
        """
        query_filter = self._build_filter(filters)

        # Qdrant Query API：同时查询两路向量，服务端 RRF 融合
        results = self.client.query_points(
            collection_name=self.collection,
            prefetch=[
                # 稠密向量检索
                QueryRequest(
                    query=dense_vector,
                    using=self.DENSE_VECTOR_NAME,
                    filter=query_filter,
                    limit=top_k * 3,  # 多取一些供 RRF 使用
                ),
                # 稀疏向量检索
                QueryRequest(
                    query=SparseVector(indices=sparse_indices, values=sparse_values),
                    using=self.SPARSE_VECTOR_NAME,
                    filter=query_filter,
                    limit=top_k * 3,
                ),
            ],
            # 服务端 RRF 融合
            query={"fusion": "rrf"},
            limit=top_k,
            with_payload=True,
        )

        return [
            SearchResult(
                id=str(point.id),
                score=point.score,
                text=point.payload.get("text", ""),
                metadata={k: v for k, v in point.payload.items() if k != "text"},
            )
            for point in results.points
        ]
```

### 延伸思考
- Qdrant 的 HNSW 实现与 Faiss 的 HNSW 在删除节点时的处理有何不同？
- 当向量数据库需要水平扩展时，分片策略（按 ID hash vs 按元数据分区）如何影响过滤性能？

---

## Q5. 检索质量评估与优化 ⭐⭐⭐

**高频标签**：`评估` `查询改写` `HyDE` `RRF`

**考察点**
- 评估指标体系
- 检索失败的根因分析
- 查询改写与 HyDE

### 参考答案

**评估指标**

| 指标 | 公式 | 含义 |
|------|------|------|
| Recall@K | 相关文档被检索到的比例 | 衡量覆盖率 |
| MRR | 1/rank of first relevant doc | 衡量第一个相关结果的位置 |
| NDCG@K | 归一化折损累积增益 | 考虑位置权重的排序质量 |
| Context Precision | 检索结果中相关文档的比例 | 衡量噪声 |
| Context Recall | 回答所需信息是否都在检索结果中 | 衡量完整性 |

**检索失败的常见原因**
1. **语义鸿沟**：用户用口语提问，文档用专业术语描述（"头疼" vs "头痛"）
2. **查询歧义**：单词多义，如 "Apple" 可能指公司或水果
3. **文档质量**：OCR 错误、格式混乱导致向量质量差
4. **分布偏移**：Embedding 模型训练数据与业务文档领域不匹配

**查询改写（Query Rewriting）**
- 用 LLM 将用户查询扩展为多个子查询，分别检索后合并
- 适合处理复杂问题（"比较 A 和 B 的优缺点"）

**HyDE（Hypothetical Document Embeddings）**
- 让 LLM 先生成一个假设性的答案文档，用该文档的向量去检索
- 原理：假设文档与真实文档在向量空间中更接近，比原始查询更有效
- 风险：LLM 幻觉可能导致假设文档偏离真实内容

### 代码示例：多路检索融合（RRF 算法，TypeScript）


```typescript
interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface RRFResult extends SearchResult {
  rrfScore: number;
  sources: string[]; // 来自哪些检索路径
}

/**
 * Reciprocal Rank Fusion (RRF)
 * 将多路检索结果融合，公式：RRF(d) = Σ 1/(k + rank_i(d))
 * k=60 是经验值，用于平滑排名靠后的文档
 */
function reciprocalRankFusion(
  resultSets: Array<{ name: string; results: SearchResult[] }>,
  k: number = 60,
  topK: number = 10
): RRFResult[] {
  const scoreMap = new Map<string, { rrfScore: number; doc: SearchResult; sources: string[] }>();

  for (const { name, results } of resultSets) {
    results.forEach((doc, index) => {
      const rank = index + 1; // 1-indexed
      const rrfContribution = 1 / (k + rank);

      if (scoreMap.has(doc.id)) {
        const entry = scoreMap.get(doc.id)!;
        entry.rrfScore += rrfContribution;
        entry.sources.push(name);
      } else {
        scoreMap.set(doc.id, {
          rrfScore: rrfContribution,
          doc,
          sources: [name],
        });
      }
    });
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map(({ rrfScore, doc, sources }) => ({ ...doc, rrfScore, sources }));
}

/**
 * 多路检索管线：稠密检索 + 稀疏检索 + HyDE 检索
 */
async function multiPathRetrieval(
  query: string,
  options: {
    topK?: number;
    enableHyDE?: boolean;
    filters?: Record<string, unknown>;
  } = {}
): Promise<RRFResult[]> {
  const { topK = 10, enableHyDE = false, filters } = options;

  const retrievalTasks: Array<Promise<{ name: string; results: SearchResult[] }>> = [
    // 路径1：稠密向量检索
    denseSearch(query, { topK: topK * 3, filters }).then((results) => ({
      name: "dense",
      results,
    })),
    // 路径2：BM25 稀疏检索
    bm25Search(query, { topK: topK * 3, filters }).then((results) => ({
      name: "bm25",
      results,
    })),
  ];

  // 路径3（可选）：HyDE 检索
  if (enableHyDE) {
    retrievalTasks.push(
      generateHypotheticalDocument(query)
        .then((hypoDoc) => denseSearch(hypoDoc, { topK: topK * 3, filters }))
        .then((results) => ({ name: "hyde", results }))
        .catch((err) => {
          // HyDE 失败不影响主流程
          console.warn("HyDE retrieval failed, skipping:", err.message);
          return { name: "hyde", results: [] };
        })
    );
  }

  const resultSets = await Promise.all(retrievalTasks);
  return reciprocalRankFusion(resultSets, 60, topK);
}

async function generateHypotheticalDocument(query: string): Promise<string> {
  // 调用 LLM 生成假设性答案文档
  // 实际实现中需要注入 LLM 客户端
  throw new Error("Not implemented - inject LLM client");
}

// 占位函数，实际实现连接向量数据库
async function denseSearch(_query: string, _opts: unknown): Promise<SearchResult[]> {
  return [];
}
async function bm25Search(_query: string, _opts: unknown): Promise<SearchResult[]> {
  return [];
}
```

### 延伸思考
- RAGAS 框架如何自动化评估 RAG 系统的 Faithfulness 和 Answer Relevancy？
- 当 HyDE 生成的假设文档包含幻觉时，如何检测并降级到普通检索？

---

## Q6. 重排序（Reranking）的原理与实现 ⭐⭐

**高频标签**：`Reranking` `Cross-Encoder` `上下文压缩`

**考察点**
- Cross-Encoder vs Bi-Encoder 的精度-速度权衡
- 主流重排模型的使用
- Context 压缩（LLMLingua）

### 参考答案

**Cross-Encoder vs Bi-Encoder**

| 维度 | Bi-Encoder | Cross-Encoder |
|------|-----------|---------------|
| 原理 | 查询和文档分别编码，计算向量相似度 | 查询+文档拼接后联合编码，输出相关性分数 |
| 精度 | 中（向量空间近似） | 高（全注意力交互） |
| 延迟 | 低（向量预计算） | 高（每对都要推理） |
| 适用 | 初步检索（召回阶段） | 精排（Top-K 重排） |

**实践建议**
- 重排只对 Top-20~50 的候选文档执行，控制延迟
- BGE-Reranker-v2-m3 在中英文场景表现优秀，支持多语言
- Cohere Rerank API 适合快速集成，但有网络延迟和成本

**LLMLingua（上下文压缩）**
- 在重排后，用小模型（如 LLaMA）对每个 chunk 计算 token 重要性，删除低重要性 token
- 压缩率可达 4x，在保持 90%+ 答案质量的同时大幅减少 LLM 输入 token 数
- 适合 context window 紧张或需要降低成本的场景

### 代码示例：带超时保护的重排序服务（TypeScript）


```typescript
interface RerankCandidate {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  originalScore: number;
}

interface RerankResult extends RerankCandidate {
  rerankScore: number;
  rank: number;
}

class RerankService {
  private readonly timeoutMs: number;
  private readonly maxCandidates: number;

  constructor(
    private readonly apiKey: string,
    options: { timeoutMs?: number; maxCandidates?: number } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 3000; // 默认 3s 超时
    this.maxCandidates = options.maxCandidates ?? 50;
  }

  /**
   * 重排序，含超时保护和降级策略。
   * 超时或失败时降级为按原始分数排序。
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK: number = 5
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    // 限制候选数量，避免超时
    const limited = candidates
      .sort((a, b) => b.originalScore - a.originalScore)
      .slice(0, this.maxCandidates);

    try {
      const reranked = await this.withTimeout(
        this.callRerankAPI(query, limited),
        this.timeoutMs
      );
      return reranked.slice(0, topK);
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      console.warn(
        `Rerank ${isTimeout ? "timed out" : "failed"}, falling back to original scores:`,
        isTimeout ? `>${this.timeoutMs}ms` : (err as Error).message
      );
      // 降级：按原始分数返回
      return limited.slice(0, topK).map((c, i) => ({
        ...c,
        rerankScore: c.originalScore,
        rank: i + 1,
      }));
    }
  }

  private async callRerankAPI(
    query: string,
    candidates: RerankCandidate[]
  ): Promise<RerankResult[]> {
    // 使用 Cohere Rerank API
    const response = await fetch("https://api.cohere.ai/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "rerank-multilingual-v3.0",
        query,
        documents: candidates.map((c) => c.text),
        top_n: candidates.length,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cohere API error ${response.status}: ${body}`);
    }

    const data = await response.json();

    return data.results.map((r: { index: number; relevance_score: number }, rank: number) => ({
      ...candidates[r.index],
      rerankScore: r.relevance_score,
      rank: rank + 1,
    }));
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}
```

### 延伸思考
- 在延迟敏感场景（< 500ms 总预算），如何在重排精度和响应速度之间做取舍？
- LLMLingua-2 相比 LLMLingua 在压缩策略上有哪些改进？

---

## Q7. RAG 的上下文组装与 Prompt 构建 ⭐⭐

**高频标签**：`Prompt 工程` `Lost in the Middle` `引用追踪`

**考察点**
- 检索结果排列顺序对生成质量的影响
- 引用来源的追踪与验证
- 上下文组装的工程实践

### 参考答案

**Lost in the Middle 问题**

Stanford 2023 年的研究表明，LLM 对 context 中间位置的信息利用率显著低于开头和结尾。对策：
1. 将最相关的文档放在 context 的开头和结尾
2. 对超长 context，使用 "U 形排列"：最相关 → 次相关 → 最相关
3. 控制 context 总长度，宁可少而精，不要多而杂

**引用来源追踪**
- 每个 chunk 携带 `source_id`、`page`、`url` 等元数据
- 在 Prompt 中要求 LLM 以 `[1]`、`[2]` 格式引用来源
- 生成后解析引用编号，映射回原始文档元数据
- 可选：用 NLI 模型验证生成内容是否有对应 chunk 支撑（幻觉检测）

### 代码示例：带来源引用的上下文组装器（TypeScript）


```typescript
interface RetrievedChunk {
  id: string;
  text: string;
  rerankScore: number;
  metadata: {
    source: string;
    title?: string;
    page?: number;
    url?: string;
  };
}

interface AssembledContext {
  systemPrompt: string;
  contextBlock: string;
  userPrompt: string;
  citations: Map<number, RetrievedChunk>; // 引用编号 → chunk
  totalTokens: number;
}

class ContextAssembler {
  constructor(
    private readonly maxContextTokens: number = 4096,
    private readonly tokenEstimator: (text: string) => number = (t) => Math.ceil(t.length / 4)
  ) {}

  /**
   * 组装上下文，实现 U 形排列（最相关在首尾）以缓解 Lost in the Middle。
   * 超出 token 预算时从中间截断。
   */
  assemble(
    query: string,
    chunks: RetrievedChunk[],
    options: { language?: "zh" | "en" } = {}
  ): AssembledContext {
    const lang = options.language ?? "zh";

    // U 形排列：按相关性排序后，奇数位放前半，偶数位放后半
    const sorted = [...chunks].sort((a, b) => b.rerankScore - a.rerankScore);
    const uShaped = this.uShapeArrange(sorted);

    // 按 token 预算截断
    const selected = this.fitToTokenBudget(uShaped);

    // 构建引用映射（1-indexed）
    const citations = new Map<number, RetrievedChunk>();
    selected.forEach((chunk, i) => citations.set(i + 1, chunk));

    // 构建 context block
    const contextLines = selected.map((chunk, i) => {
      const ref = i + 1;
      const source = chunk.metadata.title ?? chunk.metadata.source;
      const page = chunk.metadata.page ? ` p.${chunk.metadata.page}` : "";
      return `[${ref}] (来源: ${source}${page})\n${chunk.text}`;
    });
    const contextBlock = contextLines.join("\n\n---\n\n");

    const systemPrompt = lang === "zh"
      ? `你是一个专业的问答助手。请基于以下参考资料回答用户问题。
回答时必须使用 [数字] 格式标注引用来源，例如 [1][2]。
如果参考资料中没有足够信息，请明确说明"根据现有资料无法回答"，不要编造内容。`
      : `You are a professional QA assistant. Answer based on the provided references.
Cite sources using [number] format, e.g. [1][2].
If the references lack sufficient information, say "Cannot answer based on available sources" instead of fabricating.`;

    const userPrompt = `参考资料：\n\n${contextBlock}\n\n问题：${query}`;

    return {
      systemPrompt,
      contextBlock,
      userPrompt,
      citations,
      totalTokens: this.tokenEstimator(systemPrompt + userPrompt),
    };
  }

  /** 解析 LLM 回答中的引用编号，返回引用的 chunk 列表 */
  parseAndResolveCitations(
    answer: string,
    citations: Map<number, RetrievedChunk>
  ): { answer: string; usedSources: RetrievedChunk[] } {
    const refPattern = /\[(\d+)\]/g;
    const usedIndices = new Set<number>();
    let match: RegExpExecArray | null;

    while ((match = refPattern.exec(answer)) !== null) {
      const num = parseInt(match[1], 10);
      if (citations.has(num)) usedIndices.add(num);
    }

    const usedSources = Array.from(usedIndices)
      .sort((a, b) => a - b)
      .map((i) => citations.get(i)!)
      .filter(Boolean);

    return { answer, usedSources };
  }

  private uShapeArrange(chunks: RetrievedChunk[]): RetrievedChunk[] {
    if (chunks.length <= 2) return chunks;
    const front: RetrievedChunk[] = [];
    const back: RetrievedChunk[] = [];
    chunks.forEach((chunk, i) => {
      if (i % 2 === 0) front.push(chunk);
      else back.unshift(chunk); // 次相关的放末尾（逆序）
    });
    return [...front, ...back];
  }

  private fitToTokenBudget(chunks: RetrievedChunk[]): RetrievedChunk[] {
    const result: RetrievedChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const tokens = this.tokenEstimator(chunk.text);
      if (used + tokens > this.maxContextTokens) break;
      result.push(chunk);
      used += tokens;
    }
    return result;
  }
}
```

### 延伸思考
- 当用户问题需要跨多个文档综合推理时，如何设计 multi-hop RAG？
- 如何在流式输出（Streaming）场景下实时追踪引用来源？

---

## Q8. RAG 系统的异常处理与降级策略 ⭐⭐⭐

**高频标签**：`可靠性` `降级` `幻觉检测` `异常处理`

**考察点**
- 检索为空时的降级策略
- 向量数据库不可用时的 BM25 兜底
- 幻觉检测的实现思路

### 参考答案

**检索为空的处理策略**

| 策略 | 适用场景 | 风险 |
|------|---------|------|
| 直接生成（无 RAG） | 通用知识问题 | 幻觉风险高 |
| 拒绝回答 | 专业领域、合规要求高 | 用户体验差 |
| 扩大检索范围重试 | 过滤条件过严 | 增加延迟 |
| 返回相关文档列表 | 搜索场景 | 需要前端配合 |

**向量数据库不可用的降级**
- 主路径：向量数据库（Qdrant/Pinecone）
- 降级路径：本地 BM25（Elasticsearch/Whoosh）
- 兜底路径：直接调用 LLM（无检索增强）
- 使用熔断器（Circuit Breaker）模式，避免级联故障

**幻觉检测**
- **NLI 方法**：用 NLI 模型判断生成内容是否能被检索结果"蕴含"（entailment）
- **引用验证**：检查 LLM 引用的 `[1][2]` 是否真实存在于检索结果中
- **关键词覆盖**：生成答案中的关键实体是否出现在检索文档中（轻量级）

### 代码示例：完整 RAG 管线，含各阶段异常处理（Python）


```python
import asyncio
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import AsyncGenerator, List, Optional

logger = logging.getLogger(__name__)


class RetrievalMode(Enum):
    VECTOR_DB = "vector_db"
    BM25_FALLBACK = "bm25_fallback"
    NO_RETRIEVAL = "no_retrieval"


@dataclass
class RAGResponse:
    answer: str
    sources: List[dict]
    retrieval_mode: RetrievalMode
    latency_ms: dict = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    hallucination_risk: Optional[str] = None  # "low" | "medium" | "high"


class CircuitBreaker:
    """简单熔断器：连续失败超过阈值后开路，冷却后半开路探测"""

    def __init__(self, failure_threshold: int = 3, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._failures = 0
        self._last_failure_time: Optional[float] = None
        self._open = False

    def is_open(self) -> bool:
        if self._open and self._last_failure_time:
            if time.time() - self._last_failure_time > self.recovery_timeout:
                self._open = False  # 半开路，允许一次探测
        return self._open

    def record_success(self):
        self._failures = 0
        self._open = False

    def record_failure(self):
        self._failures += 1
        self._last_failure_time = time.time()
        if self._failures >= self.failure_threshold:
            self._open = True
            logger.warning(f"Circuit breaker opened after {self._failures} failures")


class RAGPipeline:
    """
    生产级 RAG 管线，含：
    - 向量数据库熔断 + BM25 降级
    - 检索为空的多级处理
    - 幻觉风险评估
    - 各阶段延迟追踪
    """

    def __init__(
        self,
        vector_db_client,
        bm25_client,
        embedding_service,
        rerank_service,
        llm_client,
        context_assembler,
    ):
        self.vector_db = vector_db_client
        self.bm25 = bm25_client
        self.embedder = embedding_service
        self.reranker = rerank_service
        self.llm = llm_client
        self.assembler = context_assembler
        self._vector_db_breaker = CircuitBreaker(failure_threshold=3, recovery_timeout=30.0)

    async def query(
        self,
        question: str,
        filters: Optional[dict] = None,
        top_k: int = 5,
        allow_no_retrieval: bool = False,
    ) -> RAGResponse:
        latency = {}
        warnings = []

        # ── 阶段1：检索 ──────────────────────────────────────────
        t0 = time.time()
        chunks, retrieval_mode = await self._retrieve_with_fallback(
            question, filters, top_k * 3, warnings
        )
        latency["retrieval_ms"] = round((time.time() - t0) * 1000)

        # ── 阶段2：检索为空处理 ──────────────────────────────────
        if not chunks:
            if not allow_no_retrieval:
                return RAGResponse(
                    answer="根据现有知识库，未找到与您问题相关的内容，建议联系人工客服。",
                    sources=[],
                    retrieval_mode=retrieval_mode,
                    latency_ms=latency,
                    warnings=["retrieval_empty"],
                    hallucination_risk="high",
                )
            warnings.append("retrieval_empty_using_llm_only")

        # ── 阶段3：重排序 ─────────────────────────────────────────
        if chunks:
            t1 = time.time()
            try:
                chunks = await self.reranker.rerank(question, chunks, top_k=top_k)
            except Exception as e:
                logger.warning(f"Rerank failed, using original order: {e}")
                warnings.append(f"rerank_failed:{type(e).__name__}")
                chunks = chunks[:top_k]
            latency["rerank_ms"] = round((time.time() - t1) * 1000)

        # ── 阶段4：上下文组装 ─────────────────────────────────────
        context = self.assembler.assemble(question, chunks)

        # ── 阶段5：LLM 生成 ───────────────────────────────────────
        t2 = time.time()
        try:
            answer = await self._generate(context)
        except asyncio.TimeoutError:
            return RAGResponse(
                answer="生成超时，请稍后重试。",
                sources=[],
                retrieval_mode=retrieval_mode,
                latency_ms=latency,
                warnings=["llm_timeout"],
            )
        latency["generation_ms"] = round((time.time() - t2) * 1000)

        # ── 阶段6：幻觉风险评估 ───────────────────────────────────
        hallucination_risk = self._assess_hallucination_risk(answer, chunks)

        sources = [
            {
                "id": c.id,
                "title": c.metadata.get("title", c.metadata.get("source", "")),
                "url": c.metadata.get("url"),
                "page": c.metadata.get("page"),
            }
            for c in chunks
        ]

        return RAGResponse(
            answer=answer,
            sources=sources,
            retrieval_mode=retrieval_mode,
            latency_ms=latency,
            warnings=warnings,
            hallucination_risk=hallucination_risk,
        )

    async def _retrieve_with_fallback(
        self, question: str, filters: Optional[dict], top_k: int, warnings: list
    ):
        """向量数据库 → BM25 降级 → 空结果"""
        # 主路径：向量数据库
        if not self._vector_db_breaker.is_open():
            try:
                query_vec = await self.embedder.embed_texts([question])
                chunks = await self.vector_db.search(
                    query_vec[0], top_k=top_k, filters=filters
                )
                self._vector_db_breaker.record_success()
                return chunks, RetrievalMode.VECTOR_DB
            except Exception as e:
                self._vector_db_breaker.record_failure()
                logger.error(f"Vector DB retrieval failed: {e}")
                warnings.append(f"vector_db_failed:{type(e).__name__}")
        else:
            warnings.append("vector_db_circuit_open")

        # 降级路径：BM25
        try:
            chunks = await self.bm25.search(question, top_k=top_k, filters=filters)
            warnings.append("using_bm25_fallback")
            return chunks, RetrievalMode.BM25_FALLBACK
        except Exception as e:
            logger.error(f"BM25 fallback also failed: {e}")
            warnings.append(f"bm25_failed:{type(e).__name__}")

        return [], RetrievalMode.NO_RETRIEVAL

    def _assess_hallucination_risk(self, answer: str, chunks: list) -> str:
        """
        轻量级幻觉风险评估：
        - 检查答案中的关键实体是否出现在检索文档中
        - 检查是否有无效引用（引用了不存在的编号）
        """
        if not chunks:
            return "high"

        # 合并所有检索文本
        context_text = " ".join(c.text for c in chunks).lower()
        answer_lower = answer.lower()

        # 简单启发式：答案中的数字/专有名词是否在 context 中出现
        import re
        numbers_in_answer = set(re.findall(r'\b\d+(?:\.\d+)?\b', answer_lower))
        numbers_in_context = set(re.findall(r'\b\d+(?:\.\d+)?\b', context_text))
        unsupported_numbers = numbers_in_answer - numbers_in_context

        if len(unsupported_numbers) > 3:
            return "high"
        elif len(unsupported_numbers) > 0:
            return "medium"
        return "low"

    async def _generate(self, context) -> str:
        # 实际实现中调用 LLM 客户端
        raise NotImplementedError("Inject LLM client implementation")
```

### 延伸思考
- 如何用 Prometheus + Grafana 监控 RAG 各阶段的 P99 延迟和降级率？
- 在多租户场景下，如何隔离不同租户的向量数据（命名空间 vs 独立集合）？

---

## 延伸阅读

1. [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (Lewis et al., 2020)](https://arxiv.org/abs/2005.11401) — RAG 原始论文，奠定基础架构

2. [Lost in the Middle: How Language Models Use Long Contexts (Liu et al., 2023)](https://arxiv.org/abs/2307.03172) — 揭示 LLM 对 context 中间位置信息利用不足的问题

3. [RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217) — RAG 自动化评估框架，定义 Faithfulness、Answer Relevancy 等指标

4. [HyDE: Precise Zero-Shot Dense Retrieval without Relevance Labels](https://arxiv.org/abs/2212.10496) — 假设文档嵌入（HyDE）的原始论文

5. [LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models](https://arxiv.org/abs/2310.05736) — 上下文压缩技术，大幅降低 LLM 推理成本

6. [Modular RAG: Transforming RAG Systems into LEGO-like Reconfigurable Frameworks](https://arxiv.org/abs/2407.21059) — Modular RAG 的系统性综述

7. [BGE M3-Embedding: Multi-Lingual, Multi-Functionality, Multi-Granularity Text Embeddings](https://arxiv.org/abs/2402.03216) — 支持稠密+稀疏+多粒度的统一 Embedding 模型

8. [Qdrant 官方文档：Hybrid Search](https://qdrant.tech/documentation/concepts/hybrid-queries/) — 生产级混合检索实现参考
