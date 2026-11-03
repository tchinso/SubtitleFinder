import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverAnime, searchAnissia, searchDirect } from './anissia.js';
import { directoryCaptions } from './blog-directory.js';

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
  assert.deepEqual(all.sources, []);
  assert.ok(fetcher.calls.every(url => !url.includes('google.com/search')));

  const chosen = await searchAnissia({ q: TITLE, animeNo: 3291, episode: 2 }, fetcher);
  assert.equal(chosen.status, 'found');
  assert.equal(chosen.candidates.length, 1);
  assert.equal(chosen.candidates[0].episode, 2);
  assert.equal(chosen.candidates[0].confidence, 'exact');
});

test('Anissia searches expose safe creator pages when no subtitle candidate is found', async () => {
  const blogger = `${BLOG}/2026/09/no-subtitle.html`;
  const naver = 'https://blog.naver.com/maker';
  const tistory = 'https://maker.tistory.com/entry/no-subtitle';
  const bloggerSearch = `${BLOG}/search?${qp(TITLE)}`;
  const naverSearch = `https://blog.naver.com/PostSearchList.naver?${new URLSearchParams({ blogId: 'maker', SearchText: TITLE })}`;
  const tistorySearch = `https://maker.tistory.com/search/${encodeURIComponent(TITLE)}`;
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/10`]: { data: [
      { name: 'Blogger 제작자', website: blogger },
      { name: '네이버 제작자', website: naver },
      { name: '티스토리 제작자', website: tistory },
      { name: '알 수 없는 사이트', website: 'https://other.example/subtitle' },
    ] },
    [blogger]: `<meta property="og:title" content="${TITLE} 2화 자막">`,
    [`${BLOG}/feeds/posts/default?alt=json&max-results=100&${qp(TITLE)}`]: { feed: { entry: [] } },
    [bloggerSearch]: '<title>검색 결과 없음</title>',
    [naverSearch]: '<title>검색 결과 없음</title>',
    ['https://rss.blog.naver.com/maker.xml']: '<rss><channel></channel></rss>',
    [`https://m.blog.naver.com/api/blogs/maker/search/post?query=${encodeURIComponent(TITLE)}&page=1`]: { result: { items: [] } },
    ['https://m.blog.naver.com/api/blogs/maker/post-list?categoryNo=0&itemCount=30&page=1']: { result: { items: [] } },
    [tistory]: `<meta property="og:title" content="${TITLE} 2화 자막">`,
    [tistorySearch]: new Response('', { status: 403 }),
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 10, episode: 2 }, fetcher);
  assert.equal(found.status, 'error');
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(found.sources, [
    { creator: 'Blogger 제작자', source_url: blogger, search_url: bloggerSearch,
      note: '지원하는 공개 자막 후보를 찾지 못했습니다. 원문을 확인해 주세요.' },
    { creator: '네이버 제작자', source_url: naver, search_url: naverSearch,
      note: '지원하는 공개 자막 후보를 찾지 못했습니다. 원문을 확인해 주세요.' },
    { creator: '티스토리 제작자', source_url: tistory, search_url: tistorySearch,
      note: '티스토리 검색: HTTP 403: maker.tistory.com' },
  ]);
  assert.ok(found.warnings.some(warning => warning.includes('자동 검색을 지원하지 않는 제작자 주소')));
  assert.ok(!fetcher.calls.includes('https://other.example/subtitle'));
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
    [`${API}/anime/list/0?${qp(TITLE)}`]: { data: { content: [{ animeNo: 4, subject: TITLE, originalSubject: '' }] } },
    [`${API}/anime/caption/animeNo/4`]: caption(naver),
    [naver]: '<iframe src="/PostView.naver?blogId=maker&amp;logNo=123"></iframe>',
    [frame]: `<meta property="og:title" content="${TITLE} 2화 자막"><a href="https://download.blog.naver.com/02.srt" download="02.srt">받기</a>`,
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 4, episode: 2 }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.deepEqual(fetcher.calls, [`${API}/anime/list/0?${qp(TITLE)}`, `${API}/anime/caption/animeNo/4`, naver, frame]);
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

test('creator recovery uses an approved exact name and rejects partial-name and unsafe directory entries', async () => {
  const recovered = 'https://newmaker.tistory.com/22';
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/1`]: caption('https://oldmaker.example', '제작팀'),
    [`${API}/translator/apply/list/0`]: { code: 'ok', data: { last: true, content: [
      { name: '제작팀 팬', result: 'PASS', website: 'https://wrong.tistory.com/1' },
      { name: '제작팀', result: 'FAIL', website: 'https://rejected.tistory.com/1' },
      { name: '제작팀', result: 'PASS', website: 'https://127.0.0.1/private' },
      { name: '제작팀', result: 'PASS', website: recovered },
    ] } },
    [`${API}/anime/caption/recent/0`]: { code: 'ok', data: { last: true, content: [] } },
    [recovered]: `<title>${TITLE} 2화 자막</title><a href="https://blog.kakaocdn.net/02.srt">02.srt</a>`,
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 1, episode: 2 }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].source_url, recovered);
  assert.deepEqual(found.warnings, []);
  assert.ok(!fetcher.calls.some(url => /wrong|rejected|127\.0\.0\.1|oldmaker/.test(url)));
});

test('recent captions recover a missing creator URL and do not join punctuation-distinct names', async () => {
  const recovered = 'https://newmaker.tistory.com/23';
  const fetcher = fakeFetch({
    [`${API}/anime/caption/animeNo/2`]: caption('', 'A+B'),
    [`${API}/translator/apply/list/0`]: { data: { last: true, content: [] } },
    [`${API}/anime/caption/recent/0`]: { data: { last: true, content: [
      { name: 'AB', website: 'https://wrong.tistory.com/1' },
      { name: 'A+B', website: recovered },
    ] } },
    [recovered]: `<title>${TITLE} 2화 자막</title><a href="https://blog.kakaocdn.net/02.srt">02.srt</a>`,
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 2, episode: 2 }, fetcher);
  assert.equal(found.candidates[0].source_url, recovered);
  assert.ok(!fetcher.calls.some(url => url.includes('wrong.tistory')));
});

test('Naver RSS recovers a post from an empty search and ignores posts belonging to another blog', async () => {
  const search = `https://blog.naver.com/PostSearchList.naver?${new URLSearchParams({ blogId: 'maker', SearchText: TITLE })}`;
  const post = 'https://blog.naver.com/maker/222';
  const fetcher = fakeFetch({
    [search]: '<title>검색 결과 없음</title><a href="http://[broken">broken</a>',
    ['https://rss.blog.naver.com/maker.xml']: `<rss><channel>
      <item><title><![CDATA[${TITLE} 2화 자막]]></title><link>https://blog.naver.com/other/999</link></item>
      <item><title><![CDATA[${TITLE} 2화 자막]]></title><link>${post}</link></item>
      </channel></rss>`,
    [post]: `<title>${TITLE} 2화 자막</title><a href="https://download.blog.naver.com/sub.srt">02.srt</a>`,
  });
  const found = await searchDirect({ q: TITLE, episode: 2, url: 'https://blog.naver.com/maker' }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].source_url, post);
  assert.deepEqual(found.warnings, []);
  assert.ok(!fetcher.calls.some(url => /other|api\/blogs/.test(url)));
});

test('Naver mobile search recovers posts when desktop search and RSS are unavailable', async () => {
  const q = '아가씨 돌보기';
  const search = `https://blog.naver.com/PostSearchList.naver?${new URLSearchParams({ blogId: 'maker', SearchText: q })}`;
  const mobile = `https://m.blog.naver.com/api/blogs/maker/search/post?query=${encodeURIComponent(q)}&page=1`;
  const post = 'https://blog.naver.com/maker/333';
  const fetcher = fakeFetch({
    [search]: new Response('', { status: 503 }),
    ['https://rss.blog.naver.com/maker.xml']: '<rss/>',
    [mobile]: { result: { items: [
      { logNoStr: '333', titleWithInspectMessage: `${q} 3화 자막` },
      { logNo: '../other/444', title: `${q} 3화 자막` },
      { logNo: '444', title: `${q} 4화 자막` },
    ] } },
    [post]: `<title>${q} 3화 자막</title><a href="https://download.blog.naver.com/sub.srt">03.srt</a>`,
  });
  const found = await searchDirect({ q, episode: 3, url: 'https://blog.naver.com/maker' }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].source_url, post);
  assert.deepEqual(found.warnings, []);
});

test('Naver mobile post list is a final fallback when the mobile search is empty', async () => {
  const search = `https://blog.naver.com/PostSearchList.naver?${new URLSearchParams({ blogId: 'maker', SearchText: TITLE })}`;
  const mobile = `https://m.blog.naver.com/api/blogs/maker/search/post?query=${encodeURIComponent(TITLE)}&page=1`;
  const post = 'https://blog.naver.com/maker/444';
  const fetcher = fakeFetch({
    [search]: '<title>empty</title>',
    ['https://rss.blog.naver.com/maker.xml']: '<rss/>',
    [mobile]: { result: { list: [] } },
    ['https://m.blog.naver.com/api/blogs/maker/post-list?categoryNo=0&itemCount=30&page=1']: {
      result: { list: [{ logNo: 444, title: `${TITLE} 2화 자막` }] },
    },
    [post]: `<title>${TITLE} 2화 자막</title><a href="https://download.blog.naver.com/sub.srt">02.srt</a>`,
  });
  const found = await searchDirect({ q: TITLE, episode: 2, url: 'https://blog.naver.com/maker' }, fetcher);
  assert.equal(found.candidates[0].source_url, post);
});

test('the curated directory requires exact work and season identity', () => {
  const data = { updated: '2026-09-30', works: [
    { ko: '예제 애니 2기', romaji: 'Example Anime 2', maker: '팀', url: 'https://maker.tistory.com/1' },
  ] };
  assert.equal(directoryCaptions(['예제 애니'], null, data).length, 0);
  assert.equal(directoryCaptions(['예제'], 2, data).length, 0);
  assert.equal(directoryCaptions(['예제 애니'], 2, data).length, 1);
  assert.equal(directoryCaptions(['Example Anime 2'], 2, data).length, 1);
});

test('curated directory fallback finds a verified post when Anissia has no work', async () => {
  const q = '한밤중 하트튠';
  const post = 'https://csora556.blogspot.com/2026/01/blog-post_7.html';
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?${qp(q)}`]: { data: { content: [] } },
    [post]: `<title>${q} 1화 자막</title><a href="https://drive.google.com/file/d/sub1/view">자막</a>`,
  });
  const found = await searchAnissia({ q, episode: 1 }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].source_url, post);
  assert.match(found.candidates[0].note, /별도 자막 목록\(2026-09-30\)/);
});

test('an explicit season filters the Anissia work before caption lookup', async () => {
  const post = 'https://maker.tistory.com/2';
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?${qp(TITLE)}`]: { data: { content: [
      { animeNo: 1, subject: TITLE }, { animeNo: 2, subject: `${TITLE} 2기` },
    ] } },
    [`${API}/anime/caption/animeNo/2`]: caption(post),
    [post]: `<title>${TITLE} 2기 1화 자막</title><a href="https://blog.kakaocdn.net/01.srt">01.srt</a>`,
  });
  const found = await searchAnissia({ q: TITLE, season: 2, episode: 1 }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.ok(!fetcher.calls.includes(`${API}/anime/caption/animeNo/1`));
});

test('image subtitle posts keep a reviewable source link without pretending to have a file', async () => {
  const post = 'https://maker.tistory.com/2';
  const fetcher = fakeFetch({
    [post]: `<title>${TITLE} 2화 자막</title><script>const viewer = 'WinPNG';</script>`,
  });
  const found = await searchDirect({ q: TITLE, episode: 2, url: post }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].download_url, '');
  assert.equal(found.candidates[0].confidence, 'review');
  assert.match(found.candidates[0].note, /이미지 자막/);
});

const driveEntry = (id, name) => `<div class="flip-entry" id="entry-${id}"><a href="https://drive.google.com/file/d/${id}/view"><div class="flip-entry-title">${name}</div></a></div>`;

test('manual shared Drive folders keep cached results scoped to the requested work', async () => {
  const folder = 'https://drive.google.com/drive/folders/sharedroot';
  const fetcher = fakeFetch({
    'https://drive.google.com/embeddedfolderview?id=sharedroot': driveEntry('bookworm1', `${TITLE} 01.ass`)
      + driveEntry('ojousama1', '아가씨 돌보기 01.ass'),
  });
  const first = await searchDirect({ q: TITLE, episode: 1, url: folder }, fetcher);
  const second = await searchDirect({ q: '아가씨 돌보기', episode: 1, url: folder }, fetcher);
  assert.equal(first.candidates.length, 1);
  assert.equal(second.candidates.length, 1);
  assert.match(first.candidates[0].download_url, /id=bookworm1/);
  assert.match(second.candidates[0].download_url, /id=ojousama1/);
});

test('a matched Blogger post expands its Drive folder by episode and retains ASS companion fonts', async () => {
  const post = `${BLOG}/2026/10/bookworm.html`;
  const folder = 'https://drive.google.com/drive/folders/bookwormroot';
  const fetcher = fakeFetch({
    [post]: `<title>${TITLE} 2화 자막</title><a href="${folder}">전체 자막 폴더</a>`,
    'https://drive.google.com/embeddedfolderview?id=bookwormroot': driveEntry('episode01', '01.ass')
      + driveEntry('episode02', '02.ass') + driveEntry('fontfile', 'Companion.ttf'),
  });
  const found = await searchDirect({ q: TITLE, episode: 2, url: post }, fetcher);
  assert.equal(found.candidates.length, 1, JSON.stringify(found));
  assert.equal(found.candidates[0].provider, 'Google Drive 폴더');
  assert.equal(found.candidates[0].file_name, '02.ass');
  assert.equal(found.candidates[0].episode, 2);
  assert.match(found.candidates[0].download_url, /id=episode02/);
  assert.equal(found.candidates[0].fonts[0].name, 'Companion.ttf');
  assert.equal(found.candidates[0].confidence, 'exact');
});

test('manual Drive folders leave anonymous episode files for review', async () => {
  const folder = 'https://drive.google.com/drive/folders/unknownroot';
  const fetcher = fakeFetch({
    'https://drive.google.com/embeddedfolderview?id=unknownroot': driveEntry('episode01', '01.ass'),
  });
  const found = await searchDirect({ q: TITLE, episode: 1, url: folder }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].confidence, 'review');
});

test('an explicitly selected original Bookworm work never returns the latest sequel sharing its title prefix', async () => {
  const original = `${TITLE} ~사서가 되기 위해서라면 뭐든지 할 수 있어~`;
  const sequel = `${TITLE} 영주의 양녀`;
  const latest = `${BLOG}/2026/09/sequel.html`;
  const old = `${BLOG}/2019/10/original.html`;
  const oldEntry = { title: { $t: `${TITLE} 2화 자막` },
    content: { $t: '<a href="https://drive.google.com/file/d/original2/view">2화 자막</a>' },
    link: [{ rel: 'alternate', href: old }] };
  const sequelEntry = { title: { $t: `${sequel} 2화 자막` },
    content: { $t: '<a href="https://drive.google.com/file/d/sequel2/view">2화 자막</a>' },
    link: [{ rel: 'alternate', href: latest }] };
  const fetcher = fakeFetch({
    [`${API}/anime/list/0?${qp(TITLE)}`]: { data: { content: [
      { animeNo: 3291, subject: sequel }, { animeNo: 1576, subject: original },
    ] } },
    [`${API}/anime/caption/animeNo/1576`]: caption(latest),
    [latest]: `<title>${sequelEntry.title.$t}</title>${sequelEntry.content.$t}`,
    [`${BLOG}/feeds/posts/default?alt=json&max-results=100&${qp(original)}`]: { feed: { entry: [sequelEntry, oldEntry] } },
  });
  const found = await searchAnissia({ q: TITLE, animeNo: 1576, episode: 2 }, fetcher);
  assert.equal(found.candidates.length, 1, JSON.stringify(found));
  assert.equal(found.candidates[0].source_url, old);
  assert.match(found.candidates[0].download_url, /original2/);
  assert.ok(!fetcher.calls.includes(`${API}/anime/caption/animeNo/3291`));
});

test('an unnumbered Blogger post uses explicit anchor ranges and retains a separate Drive font bundle', async () => {
  const q = '아가씨 돌보기';
  const post = `${BLOG}/2026/07/blog-post.html`;
  const bundle = 'https://drive.google.com/file/d/episodebundle/view';
  const fonts = 'https://drive.google.com/file/d/fontbundle/view';
  const fetcher = fakeFetch({
    [post]: `<title>${q}</title><a href="${bundle}">1 ~ 12화</a><a href="${fonts}">폰트</a>
      <a href="https://drive.google.com/file/d/unspecified/view">자막</a>`,
    [`${BLOG}/feeds/posts/default?alt=json&max-results=100&${qp(q)}`]: { feed: { entry: [] } },
    [`${BLOG}/search?${qp(q)}`]: '<title>empty</title>',
  });
  const found = await searchDirect({ q, episode: 2, url: post }, fetcher);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].download_url, bundle);
  assert.deepEqual(found.candidates[0].episode_range, [1, 12]);
  assert.equal(found.candidates[0].confidence, 'review');
  assert.deepEqual(found.candidates[0].fonts, [{ name: '폰트', url: fonts }]);
  const outside = await searchDirect({ q, episode: 13, url: post }, fetcher);
  assert.deepEqual(outside.candidates, []);
});

function episodeRetryFixture(knownPrequelCount) {
  const q = '회차 대응 예제 3기';
  const realPost = 'https://maker.tistory.com/14';
  const fixture = fakeFetch({
    [`${API}/anime/list/0?${qp(q)}`]: { data: { content: [{ animeNo: 303, subject: q, originalSubject: 'Example Third Season' }] } },
    [`${API}/anime/caption/animeNo/303`]: caption(realPost, '회차 제작자'),
    [realPost]: `<title>${q} 14화 자막</title><a href="https://blog.kakaocdn.net/14.srt">14.srt</a>`,
    [`https://maker.tistory.com/search/${encodeURIComponent(q)}`]: `<a href="${realPost}">${q} 14화 자막</a>`,
    [`https://maker.tistory.com/search/${encodeURIComponent('Example Third Season')}`]: '<title>empty</title>',
    [`${API}/translator/apply/list/0`]: { data: { last: true, content: [] } },
    [`${API}/anime/caption/recent/0`]: { data: { last: true, content: [] } },
  });
  const nodes = {
    303: { id: 303, format: 'TV', episodes: 14, relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 302, format: 'TV', episodes: knownPrequelCount ? 13 : null } },
    ] } },
    302: { id: 302, format: 'TV', episodes: 13, relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 301, format: 'TV', episodes: 13 } },
    ] } },
    301: { id: 301, format: 'TV', episodes: 13, relations: { edges: [] } },
  };
  const metadataIds = [];
  const fetcher = async (url, options) => {
    if (url !== 'https://graphql.anilist.co') return fixture(url, options);
    const id = JSON.parse(options.body).variables.id;
    metadataIds.push(id);
    return Response.json({ data: { Media: nodes[id] } });
  };
  return { q, fetcher, metadataIds };
}

test('verified AniList cumulative episode retries return review candidates with both episode numbers', async () => {
  const { q, fetcher, metadataIds } = episodeRetryFixture(true);
  const found = await searchAnissia({ q, animeNo: 303, anilistId: 303, episode: 40 }, fetcher);
  assert.equal(found.candidates.length, 1, JSON.stringify(found));
  assert.equal(found.candidates[0].episode, 40);
  assert.equal(found.candidates[0].matched_episode, 14);
  assert.equal(found.candidates[0].confidence, 'review');
  assert.equal(found.candidates[0].require_episode, true);
  assert.match(found.candidates[0].note, /40 → 14화/);
  assert.deepEqual(metadataIds, [303, 302, 301]);
});

test('unknown prequel counts never trigger an assumed thirteen-episode retry', async () => {
  const { q, fetcher, metadataIds } = episodeRetryFixture(false);
  const found = await searchAnissia({ q, animeNo: 303, anilistId: 303, episode: 40 }, fetcher);
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(metadataIds, [303]);
});
