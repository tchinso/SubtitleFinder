import assert from 'node:assert/strict';
import test from 'node:test';

import { jimakuSearchUrl, searchJimaku, parseJimakuIndex, parseJimakuFiles, parseFileEpisode, rankEpisodeFiles } from './jimaku.js';

function row(extra, href = '', name = '') {
  return `<div class="entry" data-extra="${JSON.stringify(extra).replace(/&/g, '&amp;').replace(/"/g, '&#34;')}"><a class="file-name" href="${href}">${name}</a></div>`;
}

const homepage = `<div class="outer">${row({ anilist_id: 1, name: 'Bookworm', english_name: 'Ascendance of a Bookworm', japanese_name: '本好きの下剋上' }, '/entry/10')}${row({ anilist_id: 2, name: 'Bookworm 2nd Season', english_name: 'Ascendance of a Bookworm Season 2' }, '/entry/20')}</div>`;
const files = [
  ['[Preferred] Bookworm S01E01.srt', '1'],
  ['[Preferred] Bookworm S01E02.srt', '2'],
  ['[Other] Bookworm S01E02.ass', '3'],
  ['[Preferred] Bookworm S02E02.ass', '4'],
  ['Bookworm 01-12.ass', '5'],
].map(([name, id]) => row({ name, url: `/entry/10/download/${id}`, size: 40 })).join('');

test('Jimaku direct search uses the official OpenSearch redirect', () => {
  assert.equal(
    jimakuSearchUrl(' Yosuga no Sora '),
    'https://jimaku.cc/opensearch/redirect?anime=true&query=Yosuga+no+Sora',
  );
});

test('upstream failure returns an actionable official search link', async () => {
  const result = await searchJimaku({ q: 'Frieren', season: 1, episode: 2 }, async () => new Response('', { status: 503 }));

  assert.equal(result.status, 'error');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].language, 'ja');
  assert.equal(result.candidates[0].download_url, '');
  assert.equal(result.candidates[0].source_url, jimakuSearchUrl('Frieren'));
  assert.equal(result.candidates[0].season, null);
  assert.equal(result.candidates[0].episode, null);
});

test('public HTML parses entity-escaped metadata, nested page wrappers, and trusted download URLs', () => {
  assert.equal(parseJimakuIndex(homepage).length, 2);
  const html = files + row({ name: 'evil.ass', url: 'https://evil.test/sub.ass' }) + row({ name: 'wrong-entry.ass', url: '/entry/99/download/sub.ass' }) + row({ name: 'script.js', url: '/entry/10/download/script.js' });
  assert.equal(parseJimakuFiles(html, '10').length, 5);
});

test('episode parser avoids release checksums, resolutions, and title numbers', () => {
  for (const name of ['[Group] 86 - 03 [1080p] [1A2B3C4D].ass', 'Show_S02E03.ja.srt', 'Show [03] [720p].srt', 'Show 03화.smi']) assert.equal(parseFileEpisode(name).episode, 3, name);
  assert.deepEqual(parseFileEpisode('Show S02E01-S02E12.ass').range, [1, 12]);
});

test('preferred release never admits a wrong episode or season', () => {
  const ranked = rankEpisodeFiles(parseJimakuFiles(files, '10'), { episode: 2, season: 1, preferredFile: '[Preferred] Bookworm S01E01.srt' });
  assert.equal(ranked[0].name, '[Preferred] Bookworm S01E02.srt');
  assert.equal(ranked.length, 3);
  assert.ok(!ranked.some(file => file.name.includes('S01E01') || file.name.includes('S02E02')));
});

test('public search lists episode files without credentials and deduplicates concurrent requests', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response(url === 'https://jimaku.cc/' ? homepage : files);
  };
  const query = { q: 'Ascendance of a Bookworm', season: 1, episode: 2, preferredFile: '[Preferred] Bookworm S01E01.srt' };
  const [first, second] = await Promise.all([searchJimaku(query, fetcher), searchJimaku(query, fetcher)]);
  assert.equal(first.status, 'ok');
  assert.equal(first.candidates[0].file_name, '[Preferred] Bookworm S01E02.srt');
  assert.equal(first.candidates.find(file => file.file_name.includes('01-12')).confidence, 'review');
  assert.deepEqual(first, second);
  assert.deepEqual(requests.sort(), ['https://jimaku.cc/', 'https://jimaku.cc/entry/10']);
  await searchJimaku({ ...query, refresh: true }, fetcher);
  assert.equal(requests.length, 4);
});

test('season filter selects the season entry before opening its files', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    return new Response(url === 'https://jimaku.cc/' ? homepage : row({ name: 'Bookworm S02E02.ass', url: '/entry/20/download/2.ass' }));
  };
  const result = await searchJimaku({ q: 'Ascendance of a Bookworm', season: 2, episode: 2 }, fetcher);
  assert.equal(result.candidates[0].anilist_id, 2);
  assert.ok(calls.includes('https://jimaku.cc/entry/20'));
  assert.ok(!calls.includes('https://jimaku.cc/entry/10'));
});

test('Korean title with an exact native alias resolves files; partial name remains review', async () => {
  const fetcher = async url => new Response(url === 'https://jimaku.cc/' ? homepage : files);
  const result = await searchJimaku({ q: '책벌레의 하극상', aliases: ['本好きの下剋上'], season: 1, episode: 2 }, fetcher);
  assert.equal(result.candidates[0].confidence, 'exact');
  const partial = await searchJimaku({ q: 'Bookw', season: 1, episode: 2 }, fetcher);
  assert.equal(partial.candidates[0].confidence, 'review');
});

test('an expired index may be reused on network failure only with an explicit stale warning', async () => {
  const originalNow = Date.now;
  let time = 1000, failIndex = false;
  Date.now = () => time;
  try {
    const fetcher = async url => {
      if (url === 'https://jimaku.cc/' && failIndex) throw new Error('offline');
      return new Response(url === 'https://jimaku.cc/' ? homepage : files);
    };
    const query = { q: 'Bookworm', episode: 2 };
    await searchJimaku(query, fetcher);
    time += 7 * 3600000; failIndex = true;
    const result = await searchJimaku(query, fetcher);
    assert.equal(result.status, 'ok');
    assert.match(result.warnings.join(' '), /이전 작품 목록/);
    assert.equal((await searchJimaku({ ...query, refresh: true }, fetcher)).status, 'error');
  } finally { Date.now = originalNow; }
});

test('alternate episode bundle cannot exceed verified season length', () => {
  const candidates = ['Show 01-13.ass', 'Show 01-26.ass'].map(name => ({ name }));
  const ranked = rankEpisodeFiles(candidates, { episode: 14, alternatives: [{ episode: 1, limit: 13 }] });
  assert.equal(ranked.find(file => file.alternate)?.name, 'Show 01-13.ass');
  assert.equal(ranked.find(file => file.name === 'Show 01-26.ass').alternate, false);
  assert.equal(rankEpisodeFiles(candidates, { episode: 40, alternatives: [{ episode: 1, limit: 13 }] }).length, 1);
});

test('local-to-cumulative candidates cannot select a previous season bundle or later season files', () => {
  const alternatives = [{ episode: 15, limit: 26, offset: -14, minimum: 15 }];
  const files = ['Show 15-26.ass', 'Show 01-26.ass'].map(name => ({ name }));
  assert.equal(rankEpisodeFiles(files, { episode: 1, alternatives }).find(file => file.alternate)?.name, 'Show 15-26.ass');
  assert.equal(rankEpisodeFiles([...files, { name: 'Show 27.ass' }], { episode: 1, alternatives }).filter(file => file.alternate).length, 0);
});

test('empty title is rejected', async () => {
  assert.deepEqual(await searchJimaku({ q: '  ' }), {
    status: 'error',
    warnings: ['검색할 제목을 입력해 주세요.'],
    candidates: [],
  });
});
