import assert from 'node:assert/strict';
import test from 'node:test';

import { jimakuSearchUrl, searchJimaku } from './jimaku.js';

test('Jimaku direct search uses the official OpenSearch redirect', () => {
  assert.equal(
    jimakuSearchUrl(' Yosuga no Sora '),
    'https://jimaku.cc/opensearch/redirect?anime=true&query=Yosuga+no+Sora',
  );
});

test('search returns a link without requesting an API key', async () => {
  const result = await searchJimaku({ q: 'Frieren', season: 1, episode: 2 });

  assert.equal(result.status, 'review');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].language, 'ja');
  assert.equal(result.candidates[0].download_url, '');
  assert.equal(result.candidates[0].source_url, jimakuSearchUrl('Frieren'));
  assert.equal(result.candidates[0].season, null);
  assert.equal(result.candidates[0].episode, null);
});

test('empty title is rejected', async () => {
  assert.deepEqual(await searchJimaku({ q: '  ' }), {
    status: 'error',
    warnings: ['검색할 제목을 입력해 주세요.'],
    candidates: [],
  });
});
