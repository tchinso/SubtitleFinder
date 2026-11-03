import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedValue } from './cache.js';

test('cache coalesces concurrent loads, isolates callers and permits refresh', async () => {
  const namespace = {};
  let count = 0;
  const loader = async () => { count++; await Promise.resolve(); return { candidates: ['a'], status: 'found' }; };
  const [a, b] = await Promise.all([cachedValue('q', loader, { namespace }), cachedValue('q', loader, { namespace })]);
  assert.equal(count, 1);
  a.value.candidates.push('mutated');
  assert.deepEqual(b.value.candidates, ['a']);
  assert.equal((await cachedValue('q', loader, { namespace })).cache, 'hit');
  await cachedValue('q', loader, { namespace, refresh: true });
  assert.equal(count, 2);
});

test('failed refresh preserves successful stale data without extending its lifetime', async () => {
  const namespace = {};
  let time = 0;
  const opts = { namespace, ttl: 5, staleTtl: 20, now: () => time };
  await cachedValue('q', async () => ({ status: 'found', candidates: [{ download_url: 'https://example.test/a.srt' }] }), opts);
  time = 10;
  assert.equal((await cachedValue('q', async () => ({ status: 'error' }), opts)).cache, 'stale');
  time = 25;
  assert.equal((await cachedValue('q', async () => ({ status: 'error' }), opts)).value.status, 'error');
});

test('coalesced callers retain the stale indicator after the shared refresh fails', async () => {
  const namespace = {};
  let time = 0;
  const opts = { namespace, ttl: 1, staleTtl: 100, now: () => time };
  await cachedValue('q', async () => ({ status: 'found', candidates: [{ download_url: 'https://example.test/a.srt' }] }), opts);
  time = 10;
  const fail = async () => { await Promise.resolve(); throw new Error('offline'); };
  const results = await Promise.all([cachedValue('q', fail, opts), cachedValue('q', fail, opts)]);
  assert.deepEqual(results.map(result => result.cache), ['stale', 'stale']);
});
