type CacheEntry = {
  expiresAt: number;
  payload: unknown;
};

const queueCache = new Map<string, CacheEntry>();
const QUEUE_CACHE_TTL_MS = 1_000;

export function getQueueCache(key: string): unknown | null {
  const entry = queueCache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    queueCache.delete(key);
    return null;
  }

  return entry.payload;
}

export function setQueueCache(key: string, payload: unknown): void {
  queueCache.set(key, {
    payload,
    expiresAt: Date.now() + QUEUE_CACHE_TTL_MS,
  });
}

export function invalidateQueueCache(key: string): void {
  queueCache.delete(key);
}
