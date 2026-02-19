import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  openDb,
  insertChunk,
  updateChunkIntent,
  getChunksByIds,
  getMetaChunks,
  setChunkMeta,
  type RlmChunkRow,
} from "../db.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

describe("is_meta migration", () => {
  it("rlm_chunks table has is_meta column after openDb", () => {
    const cols = db.prepare("PRAGMA table_info(rlm_chunks)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("is_meta");
  });

  it("rlm_chunks table has memory_weight column after openDb", () => {
    const cols = db.prepare("PRAGMA table_info(rlm_chunks)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("memory_weight");
  });
});

describe("updateChunkIntent", () => {
  it("updates the intent of an existing chunk", () => {
    const id = insertChunk(db, "sess1", 1, "original intent", "chunk text here!", "hash1", "assistant", 50);
    expect(id).toBeGreaterThan(0);

    updateChunkIntent(db, id, "updated intent");

    const [row] = getChunksByIds(db, [id]);
    expect(row.intent).toBe("updated intent");
  });
});

describe("getMetaChunks", () => {
  it("returns only chunks with is_meta=1 and embedding IS NOT NULL", () => {
    // Insert 3 chunks
    const id1 = insertChunk(db, "sess1", 1, "intent1", "text one", "h1", "assistant", 10);
    const id2 = insertChunk(db, "sess1", 2, "intent2", "text two", "h2", "assistant", 10);
    const id3 = insertChunk(db, "sess1", 3, "intent3", "text three", "h3", "assistant", 10);

    // Give embeddings to id1 and id2
    const fakeEmb = Buffer.alloc(4 * 3); // 3-dim float32
    db.prepare("UPDATE rlm_chunks SET embedding = ? WHERE id = ?").run(fakeEmb, id1);
    db.prepare("UPDATE rlm_chunks SET embedding = ? WHERE id = ?").run(fakeEmb, id2);

    // Set id1 and id3 as meta (id3 has no embedding)
    setChunkMeta(db, id1, 1);
    setChunkMeta(db, id3, 1);

    const meta = getMetaChunks(db);
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe(id1);
  });
});

describe("setChunkMeta", () => {
  it("toggles is_meta flag on a chunk", () => {
    const id = insertChunk(db, "sess1", 1, "intent", "text", "h_toggle", "assistant", 10);
    const fakeEmb = Buffer.alloc(4 * 3);
    db.prepare("UPDATE rlm_chunks SET embedding = ? WHERE id = ?").run(fakeEmb, id);

    // Initially 0
    let meta = getMetaChunks(db);
    expect(meta.find((m) => m.id === id)).toBeUndefined();

    // Set to 1
    setChunkMeta(db, id, 1);
    meta = getMetaChunks(db);
    expect(meta.find((m) => m.id === id)).toBeDefined();

    // Set back to 0
    setChunkMeta(db, id, 0);
    meta = getMetaChunks(db);
    expect(meta.find((m) => m.id === id)).toBeUndefined();
  });
});

describe("RlmChunkRow.is_meta", () => {
  it("returned row includes is_meta field", () => {
    const id = insertChunk(db, "sess1", 1, "intent", "text content", "h_field", "assistant", 10);
    const [row] = getChunksByIds(db, [id]) as RlmChunkRow[];
    expect(row).toHaveProperty("is_meta");
    expect(typeof row.is_meta).toBe("number");
    expect(row.is_meta).toBe(0);
  });
});
