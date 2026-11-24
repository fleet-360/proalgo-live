import { randomUUID } from "node:crypto";
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
  /** Returns an owner token, or null when someone else holds the lock. */
  tryLock(id: string, ttlSec: number): Promise<string | null>;
  /** Releases the lock only if it is still ours (a run that outlived its TTL must not free a newer run's lock). */
  unlock(id: string, token: string): Promise<void>;
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
    const token = randomUUID();
    return (await this.r.set(k.lock(id), token, { nx: true, ex: ttlSec })) === "OK" ? token : null;
  }
  async unlock(id: string, token: string) {
    await this.r.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      [k.lock(id)],
      [token],
    );
  }
}

class MemoryStore implements Store {
  private metas = new Map<string, SessionMeta>();
  private segs = new Map<string, Segment[]>();
  private notes = new Map<string, Note[]>();
  private locks = new Map<string, { until: number; token: string }>();
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
    const cur = this.locks.get(id);
    if (cur && cur.until > Date.now()) return null;
    const token = randomUUID();
    this.locks.set(id, { until: Date.now() + ttlSec * 1000, token });
    return token;
  }
  async unlock(id: string, token: string) {
    if (this.locks.get(id)?.token === token) this.locks.delete(id);
  }
}

/** Upstash env names depend on the prefix chosen in Vercel (KV_, STORAGE_, ...), so fall back to a suffix match. */
function findRedisEnv(): { url?: string; token?: string } {
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const urlKey = Object.keys(env).find((k) => k.endsWith("_REST_API_URL"));
    if (urlKey) {
      const prefix = urlKey.slice(0, -"_REST_API_URL".length);
      url = env[urlKey];
      token = env[`${prefix}_REST_API_TOKEN`];
    }
  }
  return { url, token };
}

function makeStore(): Store {
  const { url, token } = findRedisEnv();
  if (url && token) return new RedisStore(new Redis({ url, token }));
  if (process.env.VERCEL) {
    console.warn("No Redis configured on Vercel: sessions will be lost between requests. Add Upstash for Redis.");
  }
  return new MemoryStore();
}

// Survive Next.js dev hot reloads.
const g = globalThis as unknown as { __liveStore?: Store };
export const store: Store = g.__liveStore ?? (g.__liveStore = makeStore());
