// HNSW (Hierarchical Navigable Small World) vector index
// O(log n) approximate nearest-neighbor search for cosine similarity
// Adapted from claude-flow's hnsw-index.ts with simplifications for our scale

import { rlmLog } from "./rlm-debug.js";

// --- Binary Heap (min-heap by default, max-heap via comparator) ---

interface HeapEntry {
  id: number;
  distance: number;
}

class BinaryMinHeap {
  private heap: HeapEntry[] = [];

  get size(): number { return this.heap.length; }

  push(entry: HeapEntry): void {
    this.heap.push(entry);
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek(): HeapEntry | undefined { return this.heap[0]; }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].distance >= this.heap[parent].distance) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].distance < this.heap[smallest].distance) smallest = left;
      if (right < n && this.heap[right].distance < this.heap[smallest].distance) smallest = right;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

class BinaryMaxHeap {
  private heap: HeapEntry[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number { return this.heap.length; }

  push(entry: HeapEntry): void {
    if (this.heap.length < this.maxSize) {
      this.heap.push(entry);
      this._bubbleUp(this.heap.length - 1);
    } else if (entry.distance < this.heap[0].distance) {
      // Replace worst element if new one is better (smaller distance = more similar)
      this.heap[0] = entry;
      this._sinkDown(0);
    }
  }

  peek(): HeapEntry | undefined { return this.heap[0]; }

  toSorted(): HeapEntry[] {
    return [...this.heap].sort((a, b) => a.distance - b.distance);
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].distance <= this.heap[parent].distance) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].distance > this.heap[largest].distance) largest = left;
      if (right < n && this.heap[right].distance > this.heap[largest].distance) largest = right;
      if (largest === i) break;
      [this.heap[i], this.heap[largest]] = [this.heap[largest], this.heap[i]];
      i = largest;
    }
  }
}

// --- HNSW Node ---

interface HnswNode {
  id: number;
  vector: Float32Array;
  normalized: Float32Array; // pre-normalized for fast cosine
  level: number;
  connections: Map<number, Set<number>>; // level → set of neighbor IDs
}

// --- HNSW Index ---

export interface SearchResult {
  id: number;
  similarity: number; // cosine similarity (0-1)
}

export class HnswIndex {
  private nodes: Map<number, HnswNode> = new Map();
  private entryPoint: number | null = null;
  private maxLevel = 0;

  // Hyperparameters
  private readonly M: number;          // max connections per node per level
  private readonly efConstruction: number; // candidate list size during build
  private readonly efSearch: number;   // candidate list size during search
  private readonly levelMult: number;  // level generation multiplier

  private searchCount = 0;
  private totalSearchTimeMs = 0;

  constructor(opts?: { M?: number; efConstruction?: number; efSearch?: number }) {
    this.M = opts?.M ?? 16;
    this.efConstruction = opts?.efConstruction ?? 200;
    this.efSearch = opts?.efSearch ?? 50;
    this.levelMult = 1 / Math.log(this.M);
  }

  get size(): number { return this.nodes.size; }

  get stats(): { size: number; maxLevel: number; avgSearchMs: number } {
    return {
      size: this.nodes.size,
      maxLevel: this.maxLevel,
      avgSearchMs: this.searchCount > 0
        ? Math.round((this.totalSearchTimeMs / this.searchCount) * 100) / 100
        : 0,
    };
  }

  // --- Pre-normalize a vector to unit length ---
  private normalize(v: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    const result = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) result[i] = v[i] / norm;
    return result;
  }

  // --- Cosine distance using pre-normalized vectors (just 1 - dot product) ---
  private cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - Math.max(0, Math.min(1, dot));
  }

  // --- Random level assignment (geometric distribution) ---
  private randomLevel(): number {
    let level = 0;
    while (Math.random() < 0.5 && level < 16) level++;
    return level;
  }

  // --- Insert a vector ---
  insert(id: number, vector: Float32Array): void {
    if (this.nodes.has(id)) return; // already indexed

    const normalized = this.normalize(vector);
    const level = this.randomLevel();
    const node: HnswNode = {
      id,
      vector,
      normalized,
      level,
      connections: new Map(),
    };

    // Initialize connection sets for each level
    for (let l = 0; l <= level; l++) {
      node.connections.set(l, new Set());
    }

    this.nodes.set(id, node);

    if (this.entryPoint === null) {
      // First node
      this.entryPoint = id;
      this.maxLevel = level;
      return;
    }

    const ep = this.nodes.get(this.entryPoint)!;
    let currentNodeId = this.entryPoint;

    // Greedy descent from top level to node's level + 1
    for (let l = this.maxLevel; l > level; l--) {
      currentNodeId = this.greedyClosest(normalized, currentNodeId, l);
    }

    // Insert at each level from min(level, maxLevel) down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayer(normalized, currentNodeId, this.efConstruction, l);

      // Select M closest neighbors
      const selected = neighbors.slice(0, this.M);

      for (const neighbor of selected) {
        // Bidirectional connection
        node.connections.get(l)!.add(neighbor.id);
        const neighborNode = this.nodes.get(neighbor.id);
        if (neighborNode) {
          if (!neighborNode.connections.has(l)) {
            neighborNode.connections.set(l, new Set());
          }
          neighborNode.connections.get(l)!.add(id);

          // Prune if too many connections
          const maxConn = l === 0 ? this.M * 2 : this.M;
          const conns = neighborNode.connections.get(l)!;
          if (conns.size > maxConn) {
            this.pruneConnections(neighborNode, l, maxConn);
          }
        }
      }

      if (selected.length > 0) {
        currentNodeId = selected[0].id;
      }
    }

    // Update entry point if new node has higher level
    if (level > this.maxLevel) {
      this.entryPoint = id;
      this.maxLevel = level;
    }
  }

  // --- Remove a node (for GC) ---
  remove(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove all connections to this node
    for (const [level, neighbors] of node.connections) {
      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor) {
          neighbor.connections.get(level)?.delete(id);
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if we deleted it
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        // Pick the node with highest level
        let bestId = -1;
        let bestLevel = -1;
        for (const [nid, n] of this.nodes) {
          if (n.level > bestLevel) {
            bestLevel = n.level;
            bestId = nid;
          }
        }
        this.entryPoint = bestId;
        this.maxLevel = bestLevel;
      }
    }

    return true;
  }

  // --- Search: find k nearest neighbors ---
  search(query: Float32Array, k: number): SearchResult[] {
    if (this.entryPoint === null || this.nodes.size === 0) return [];

    const start = performance.now();
    const queryNorm = this.normalize(query);

    let currentNodeId = this.entryPoint;

    // Greedy descent from top to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currentNodeId = this.greedyClosest(queryNorm, currentNodeId, l);
    }

    // Search at layer 0 with ef candidates
    const ef = Math.max(k, this.efSearch);
    const candidates = this.searchLayer(queryNorm, currentNodeId, ef, 0);

    const results = candidates.slice(0, k).map(c => ({
      id: c.id,
      similarity: Math.round((1 - c.distance) * 10000) / 10000,
    }));

    this.searchCount++;
    this.totalSearchTimeMs += performance.now() - start;

    return results;
  }

  // --- Layer search using binary heaps ---
  private searchLayer(
    queryNorm: Float32Array,
    entryId: number,
    ef: number,
    level: number
  ): HeapEntry[] {
    const entryNode = this.nodes.get(entryId);
    if (!entryNode) return [];

    const entryDist = this.cosineDistance(queryNorm, entryNode.normalized);
    const candidates = new BinaryMinHeap(); // closest first
    const results = new BinaryMaxHeap(ef);  // bounded, worst-first
    const visited = new Set<number>();

    candidates.push({ id: entryId, distance: entryDist });
    results.push({ id: entryId, distance: entryDist });
    visited.add(entryId);

    while (candidates.size > 0) {
      const closest = candidates.pop()!;
      const worstResult = results.peek();

      // If closest candidate is farther than worst result, stop
      if (worstResult && closest.distance > worstResult.distance && results.size >= ef) {
        break;
      }

      const closestNode = this.nodes.get(closest.id);
      if (!closestNode) continue;

      const neighbors = closestNode.connections.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = this.cosineDistance(queryNorm, neighborNode.normalized);
        const worstNow = results.peek();

        if (results.size < ef || (worstNow && dist < worstNow.distance)) {
          candidates.push({ id: neighborId, distance: dist });
          results.push({ id: neighborId, distance: dist });
        }
      }
    }

    return results.toSorted();
  }

  // --- Greedy closest: find single closest node at a given level ---
  private greedyClosest(queryNorm: Float32Array, startId: number, level: number): number {
    let currentId = startId;
    let currentDist = this.cosineDistance(queryNorm, this.nodes.get(startId)!.normalized);

    let improved = true;
    while (improved) {
      improved = false;
      const currentNode = this.nodes.get(currentId);
      if (!currentNode) break;

      const neighbors = currentNode.connections.get(level);
      if (!neighbors) break;

      for (const neighborId of neighbors) {
        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;
        const dist = this.cosineDistance(queryNorm, neighborNode.normalized);
        if (dist < currentDist) {
          currentId = neighborId;
          currentDist = dist;
          improved = true;
        }
      }
    }

    return currentId;
  }

  // --- Prune connections to keep only the closest M ---
  private pruneConnections(node: HnswNode, level: number, maxConn: number): void {
    const conns = node.connections.get(level);
    if (!conns || conns.size <= maxConn) return;

    const distances: HeapEntry[] = [];
    for (const neighborId of conns) {
      const neighbor = this.nodes.get(neighborId);
      if (neighbor) {
        distances.push({
          id: neighborId,
          distance: this.cosineDistance(node.normalized, neighbor.normalized),
        });
      }
    }

    distances.sort((a, b) => a.distance - b.distance);
    const keep = new Set(distances.slice(0, maxConn).map(d => d.id));

    for (const neighborId of conns) {
      if (!keep.has(neighborId)) {
        conns.delete(neighborId);
      }
    }
  }
}

// --- Singleton index management ---

let globalIndex: HnswIndex | null = null;
let indexedChunkIds: Set<number> = new Set();

/**
 * Get or build the HNSW index from the database.
 * Populates on first call, incrementally updates on subsequent calls.
 */
export function getOrBuildIndex(
  allEmbeddings: Array<{ id: number; embedding: Buffer }>
): HnswIndex {
  if (!globalIndex) {
    globalIndex = new HnswIndex({ M: 16, efConstruction: 200, efSearch: 50 });
    indexedChunkIds = new Set();
  }

  let newCount = 0;
  for (const row of allEmbeddings) {
    if (indexedChunkIds.has(row.id)) continue;
    const vec = bufferToFloat32Local(row.embedding);
    globalIndex.insert(row.id, vec);
    indexedChunkIds.add(row.id);
    newCount++;
  }

  // Remove any nodes that are no longer in the DB
  const currentIds = new Set(allEmbeddings.map(r => r.id));
  for (const id of indexedChunkIds) {
    if (!currentIds.has(id)) {
      globalIndex.remove(id);
      indexedChunkIds.delete(id);
    }
  }

  if (newCount > 0) {
    rlmLog("hnsw", `Index updated: +${newCount} nodes, total=${globalIndex.size}`, globalIndex.stats);
  }

  return globalIndex;
}

/**
 * Reset the index (call after garbage collection or major changes).
 */
export function resetIndex(): void {
  globalIndex = null;
  indexedChunkIds = new Set();
}

// Local buffer conversion (avoid circular import)
function bufferToFloat32Local(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}
