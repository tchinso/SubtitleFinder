import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverAnime, searchAnissia, searchDirect } from './anissia.js';

const API = 'https://api.anissia.net';
const BLOG = 'https://maker.blogspot.com';
const TITLE = '책벌레의 하극상';
const qp = (value) => new URLSearchParams({ q: value }).toString();

function fakeFetch(fixtures) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (!Object.hasOwn(fixtures, url)) throw new Error(`Unexpected request: ${url}`);
    const value = fixtures[url];
    if (value instanceof Response) return value;
    return typeof value === 'string'
      ? new Response(value, { headers: { 'Content-Type': 'text/html' } })
      : Response.json(value);
  };
  fetcher.calls = calls;
  return fetcher;
}

function caption(website, name = '제작자') {
  return { data: [{ name, website }] };
}

function entry(episode) {
  return {
    title: { $t: `${TITLE} ${episode}화 자막` },
    content: { $t: `<a href="https://drive.google.com/file/d/episode_${episode}/view">Google Drive 자막</a>` },
    link: [{ rel: 'alternate', href: `${BLOG}/2026/09/${episode}.html` }],
  };
}

test('discovers matching Anissia works across pages with stable snake_case fields', async () => {
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?${qp('책벌레')}`]: {
      data: { totalPages: 2, content: [
        { animeNo: 7, subject: TITLE, originalSubject: 'Honzuki no Gekokujou' },
        { animeNo: 8, subject: '다른 작품', originalSubject: '' },
      ] },
    },
    [`${API}/anime/list/1?${qp('책벌레')}`]: {
      data: { totalPages: 2, content: [{ animeNo: 9, subject: '책벌레의 하극상 2기', originalSubject: '' }] },
    },
  });
  const result = await discoverAnime('책벌레', fetcher);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.anime, [
    { anime_no: 7, subject: TITLE, original_subject: 'Honzuki no Gekokujou' },
    { anime_no: 9, subject: '책벌레의 하극상 2기', original_subject: '' },
  ]);
  assert.equal(fetcher.calls.length, 2);
});

test('selected Blogger work collects older episodes from public feed', async () => {
  const latest = `${BLOG}/2026/09/23.html`;
  const feed = `${BLOG}/feeds/posts/default?alt=json&max-results=100&${qp(TITLE)}`;
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/3291`]: caption(latest, '카이란'),
    [latest]: `<meta property="og:title" content="${TITLE} 23화 자막">${entry(23).content.$t}`,
    [feed]: { feed: { 'openSearch$totalResults': { $t: '2' }, entry: [entry(2), entry(23)] } },
  });
  const all = await searchAnissia({ q: TITLE, animeNo: 3291 }, fetcher);
  assert.equal(all.status, 'review');
  assert.deepEqual(all.candidates.map(item => item.episode).sort((a, b) => a - b), [2, 23],
    JSON.stringify({ calls: fetcher.calls, warnings: all.warnings }));
  assert.ok(all.candidates.every(item => item.provider === 'ReAnime/Blogger'));
  assert.ok(all.candidates.every(item => item.download_url.startsWith('https://drive.google.com/file/d/')));
  assert.ok(fetcher.calls.every(url => !url.includes('google.com/search')));

  const chosen = await searchAnissia({ q: TITLE, animeNo: 3291, episode: 2 }, fetcher);
  assert.equal(chosen.status, 'found');
  assert.equal(chosen.candidates.length, 1);
  assert.equal(chosen.candidates[0].episode, 2);
  assert.equal(chosen.candidates[0].confidence, 'exact');
});

test('title search resolves an exact Anissia work before reading captions', async () => {
  const latest = `${BLOG}/2026/09/2.html`;
  const feed = `${BLOG}/feeds/posts/default?alt=json&max-results=100&${qp(TITLE)}`;
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?${qp(TITLE)}`]: { data: { content: [
      { animeNo: 7, subject: TITLE, originalSubject: '' },
      { animeNo: 8, subject: `${TITLE} 2기`, originalSubject: '' },
    ] } },
    [`${API}/anime/caption/animeNo/7`]: caption(latest),
    [latest]: `<meta property="og:title" content="${TITLE} 2화 자막">${entry(2).content.$t}`,
    [feed]: { feed: { entry: [entry(2)] } },
  });
  const found = await searchAnissia({ q: TITLE }, fetcher);
  assert.equal(found.candidates.length, 1, JSON.stringify({ calls: fetcher.calls, warnings: found.warnings }));
  assert.equal(found.candidates[0].episode, 2);
  assert.ok(!fetcher.calls.some(url => url.endsWith('/animeNo/8')));
});

test('Naver and Tistory latest public post attachments use only expected hosts', async () => {
  const naver = 'https://blog.naver.com/maker/123';
  const tistory = 'https://maker.tistory.com/entry/episode-2';
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/1`]: { data: [
      { name: '네이버', website: naver }, { name: '티스토리', website: tistory },
    ] },
    [naver]: `<meta property="og:title" content="${TITLE} 2화 자막"><a href="https://download.blog.naver.com/02.srt" download="${TITLE} 02화.srt">자막</a>`,
    [tistory]: `<meta property="og:title" content="${TITLE} 2화 자막"><a href="https://blog.kakaocdn.net/02.srt">자막</a>`,
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 1, episode: 2 }, fetcher);
  assert.equal(found.status, 'found');
  assert.deepEqual(new Set(found.candidates.map(item => item.provider)), new Set(['ReAnime/네이버', 'ReAnime/티스토리']));
  assert.ok(found.candidates.every(item => item.episode === 2 && item.confidence === 'exact'));
});

test('Naver post iframe is read only when it points to the same registered post', async () => {
  const naver = 'https://blog.naver.com/maker/123';
  const frame = 'https://blog.naver.com/PostView.naver?blogId=maker&logNo=123';
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/4`]: caption(naver),
    [naver]: '<iframe src="/PostView.naver?blogId=maker&amp;logNo=123"></iframe>',
    [frame]: `<meta property="og:title" content="${TITLE} 2화 자막"><a href="https://download.blog.naver.com/02.srt" download="02.srt">받기</a>`,
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 4, episode: 2 }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.deepEqual(fetcher.calls, [`${API}/anime/caption/animeNo/4`, naver, frame]);
});

test('manual links reject unknown hosts and only admit verified attachment or Drive paths', async () => {
  const failFetch = async () => { throw new Error('must not fetch'); };
  const unsafe = await searchDirect({ q: TITLE, url: 'https://127.0.0.1/private' }, failFetch);
  assert.equal(unsafe.status, 'error');
  assert.equal(unsafe.candidates.length, 0);
  const fakeDrive = await searchDirect({ q: TITLE, url: 'https://drive.google.com/evil' }, failFetch);
  assert.equal(fakeDrive.candidates.length, 0);
  const drive = await searchDirect({ q: TITLE, url: 'https://drive.google.com/file/d/episode_2/view' }, failFetch);
  assert.equal(drive.candidates.length, 1);
  assert.equal(drive.candidates[0].confidence, 'review');
  const file = await searchDirect({ q: TITLE, url: 'https://blog.kakaocdn.net/subtitle.srt' }, failFetch);
  assert.equal(file.candidates[0].file_name, 'subtitle.srt');
});

test('redirects to disallowed hosts are blocked before requesting them', async () => {
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?q=x`]: new Response(null, { status: 302, headers: { Location: 'https://attacker.example/private' } }),
  });
  const found = await discoverAnime('x', fetcher);
  assert.equal(found.status, 'error');
  assert.equal(fetcher.calls.length, 1);
  assert.match(found.warnings[0], /허용되지 않은 주소/);
});
