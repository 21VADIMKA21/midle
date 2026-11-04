type CacheEntry = {
  expiresAt: number;
  payload: unknown;
};

let queueCache: CacheEntry | null = null;
const QUEUE_CACHE_TTL_MS = 1_000;

export function getQueueCache(): unknown | null {
  if (!queueCache) return null;
  if (queueCache.expiresAt <= Date.now()) {
    queueCache = null;
    return null;
  }
  return queueCache.payload;
}

export function setQueueCache(payload: unknown): void {
  queueCache = {
    payload,
    expiresAt: Date.now() + QUEUE_CACHE_TTL_MS,
  };
}

export function invalidateQueueCache(): void {
  queueCache = null;
}
