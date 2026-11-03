import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEpisodeRelations, verifiedEpisodeAlternatives, resolveAniListId } from './episode-matching.js';

test('cumulative numbering only maps into the selected known season', () => {
  assert.deepEqual(verifiedEpisodeAlternatives(40, { parts: [13, 13, 14], at: 2 }), [{ episode: 14, limit: 14, offset: 26 }]);
  assert.deepEqual(verifiedEpisodeAlternatives(40, { parts: [13, 13, 14], at: 1 }), []);
  assert.deepEqual(verifiedEpisodeAlternatives(40, { parts: [13, null, 14], at: 2 }), []);
  assert.deepEqual(verifiedEpisodeAlternatives(14, { parts: [13, null], at: 1 }), []);
  assert.deepEqual(verifiedEpisodeAlternatives(1, { parts: [14, 12], at: 1 }), [{ episode: 15, limit: 26, offset: -14, minimum: 15 }]);
});

test('AniList identity requires one exact title and does not pick partial matches', async () => {
  const fetcher = async () => Response.json({ data: { Page: { media: [{ id: 1, title: { native: '才女のお世話（試験）' } }, { id: 2, title: { native: '才女のお世話 第2期' } }] } } });
  assert.equal(await resolveAniListId('才女のお世話(試験)', fetcher), 1);
  assert.equal(await resolveAniListId('才女のお世話', fetcher), null);
});

test('AniList rejects oversized streamed payload before parsing', async () => {
  const fetcher = async () => new Response('x'.repeat(256 * 1024 + 1));
  await assert.rejects(resolveAniListId('Example', fetcher), /너무 큽니다/);
});

test('AniList chain is bounded, deduplicated, and excludes ambiguous prequels', async () => {
  const nodes = {
    1: { id: 1, format: 'TV', episodes: 13, relations: { edges: [] } },
    2: { id: 2, format: 'TV', episodes: 14, relations: { edges: [{ relationType: 'PREQUEL', node: { id: 1, format: 'TV', episodes: 13 } }] } },
  };
  let count = 0;
  const fetcher = async (_url, options) => { count++; assert.equal(options.redirect, 'manual'); return Response.json({ data: { Media: nodes[JSON.parse(options.body).variables.id] } }); };
  const [a, b] = await Promise.all([loadEpisodeRelations(2, fetcher), loadEpisodeRelations(2, fetcher)]);
  assert.deepEqual(a, { parts: [13, 14], at: 1 });
  assert.deepEqual(a, b);
  assert.equal(count, 2);
  await loadEpisodeRelations(2, fetcher);
  assert.equal(count, 2);
  nodes[2].relations.edges.push({ relationType: 'PREQUEL', node: { id: 3, format: 'TV', episodes: 12 } });
  assert.deepEqual(await loadEpisodeRelations(2, fetcher, { refresh: true }), { parts: [14], at: 0 });
});
