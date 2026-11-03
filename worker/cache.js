// Bounded, per-isolate caches. No credentials or private responses are stored.
const namespaces = new WeakMap();

export async function cachedValue(key, loader, {
  namespace = globalThis, refresh = false, ttl = 300_000, emptyTtl = 30_000,
  staleTtl = 86_400_000, maxEntries = 64, now = Date.now,
  isSuccess = value => value?.status !== 'error',
  isEmpty = value => value?.status === 'empty' || Array.isArray(value?.candidates) && !value.candidates.some(item => item.download_url),
} = {}) {
  let state = namespaces.get(namespace);
  if (!state) namespaces.set(namespace, state = { values: new Map(), pending: new Map(), weight: 0 });
  const old = state.values.get(key);
  const time = now();
  if (!refresh && old && old.expires > time) return { value: structuredClone(old.value), cache: 'hit' };
  if (state.pending.has(key)) {
    const result = await state.pending.get(key);
    return { ...result, value: structuredClone(result.value), cache: result.cache === 'stale' ? 'stale' : 'coalesced' };
  }
  const pending = (async () => {
    try {
      const value = await loader();
      if (!isSuccess(value)) throw Object.assign(new Error('갱신 실패'), { result: value });
      const weight = typeof value === 'string' ? value.length * 2 : value?.bytes instanceof Uint8Array ? value.bytes.byteLength : JSON.stringify(value ?? null).length * 2;
      state.weight -= state.values.get(key)?.weight || 0;
      state.values.delete(key);
      if (weight <= 16 * 1024 * 1024) {
        state.values.set(key, { value: structuredClone(value), weight, expires: now() + (isEmpty(value) ? emptyTtl : ttl), saved: now() });
        state.weight += weight;
      }
      while (state.values.size > maxEntries || state.weight > 16 * 1024 * 1024) {
        const first = state.values.keys().next().value;
        state.weight -= state.values.get(first).weight;
        state.values.delete(first);
      }
      return { value, cache: refresh ? 'refresh' : 'miss' };
    } catch (error) {
      if (old && time - old.saved < staleTtl) return { value: structuredClone(old.value), cache: 'stale' };
      if (error.result) return { value: error.result, cache: 'miss' };
      throw error;
    }
  })();
  state.pending.set(key, pending);
  try { return await pending; }
  finally { state.pending.delete(key); }
}
