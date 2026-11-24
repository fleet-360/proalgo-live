import { Redis } from "@upstash/redis";
import type { Note, Segment, SessionMeta } from "./schema";

/**
 * Session storage. Uses Upstash Redis when configured (production on Vercel),
 * otherwise an in-memory store that only works for a single local process.
 *
 * Segments and notes live in Redis lists so the two audio channels can append
 * at the same time without overwriting each other.
 */
interface Store {
  getMeta(id: string): Promise<SessionMeta | null>;
  saveMeta(meta: SessionMeta): Promise<void>;
  appendSegments(id: string, segs: Segment[]): Promise<void>;
  getSegments(id: string): Promise<Segment[]>;
  appendNote(id: string, note: Note): Promise<void>;
  getNotes(id: string): Promise<Note[]>;
  tryLock(id: string, ttlSec: number): Promise<boolean>;
  unlock(id: string): Promise<void>;
}

const TTL_SEC = 60 * 60 * 24 * 120; // keep sessions ~4 months

const k = {
  meta: (id: string) => `live:${id}:meta`,
  segs: (id: string) => `live:${id}:segs`,
  notes: (id: string) => `live:${id}:notes`,
  lock: (id: string) => `live:${id}:lock`,
};

class RedisStore implements Store {
  constructor(private r: Redis) {}
  async getMeta(id: string) {
    return (await this.r.get<SessionMeta>(k.meta(id))) ?? null;
  }
  async saveMeta(meta: SessionMeta) {
    await this.r.set(k.meta(meta.id), meta, { ex: TTL_SEC });
  }
  async appendSegments(id: string, segs: Segment[]) {
    if (!segs.length) return;
    await this.r.rpush(k.segs(id), ...segs.map((s) => JSON.stringify(s)));
    await this.r.expire(k.segs(id), TTL_SEC);
  }
  async getSegments(id: string) {
    const raw = await this.r.lrange<string | Segment>(k.segs(id), 0, -1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as Segment) : x));
  }
  async appendNote(id: string, note: Note) {
    await this.r.rpush(k.notes(id), JSON.stringify(note));
    await this.r.expire(k.notes(id), TTL_SEC);
  }
  async getNotes(id: string) {
    const raw = await this.r.lrange<string | Note>(k.notes(id), 0, -1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as Note) : x));
  }
  async tryLock(id: string, ttlSec: number) {
    return (await this.r.set(k.lock(id), "1", { nx: true, ex: ttlSec })) === "OK";
  }
  async unlock(id: string) {
    await this.r.del(k.lock(id));
  }
}

class MemoryStore implements Store {
  private metas = new Map<string, SessionMeta>();
  private segs = new Map<string, Segment[]>();
  private notes = new Map<string, Note[]>();
  private locks = new Map<string, number>();
  async getMeta(id: string) {
    const m = this.metas.get(id);
    return m ? structuredClone(m) : null;
  }
  async saveMeta(meta: SessionMeta) {
    this.metas.set(meta.id, structuredClone(meta));
  }
  async appendSegments(id: string, segs: Segment[]) {
    this.segs.set(id, [...(this.segs.get(id) ?? []), ...segs]);
  }
  async getSegments(id: string) {
    return [...(this.segs.get(id) ?? [])];
  }
  async appendNote(id: string, note: Note) {
    this.notes.set(id, [...(this.notes.get(id) ?? []), note]);
  }
  async getNotes(id: string) {
    return [...(this.notes.get(id) ?? [])];
  }
  async tryLock(id: string, ttlSec: number) {
    const until = this.locks.get(id) ?? 0;
    if (until > Date.now()) return false;
    this.locks.set(id, Date.now() + ttlSec * 1000);
    return true;
  }
  async unlock(id: string) {
    this.locks.delete(id);
  }
}

function makeStore(): Store {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore(new Redis({ url, token }));
  if (process.env.VERCEL) {
    console.warn("No Redis configured on Vercel: sessions will be lost between requests. Add Upstash for Redis.");
  }
  return new MemoryStore();
}

// Survive Next.js dev hot reloads.
const g = globalThis as unknown as { __liveStore?: Store };
export const store: Store = g.__liveStore ?? (g.__liveStore = makeStore());
