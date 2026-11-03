// Read-only acceptance checks against a local or deployed Worker.
// Usage: node scripts/smoke.mjs [https://sub.h2h.workers.dev] [--first-season]
// SMOKE_VERSION overrides the expected release marker. No subtitle text is logged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectSubtitle } from '../worker/subtitle-files.js';

const args = process.argv.slice(2);
const base = new URL(args.find(value => !value.startsWith('--')) || 'https://sub.h2h.workers.dev');
assert.ok(['http:', 'https:'].includes(base.protocol), 'Base URL must use HTTP or HTTPS.');
assert.equal(base.username + base.password, '', 'Base URL must not contain credentials.');
const expectedVersion = process.env.SMOKE_VERSION || '2026-11-03-discovery';
const started = Date.now();
const checks = [];
let active = 0, requests = 0;
const queue = [];
const inspected = new Map();

async function limited(task) {
  if (active >= 3) await new Promise(resolve => queue.push(resolve));
  else active++;
  try { return await task(); }
  finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

function path(route, params = {}) {
  const url = new URL(route, base);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
  return url;
}

async function request(route, params = {}, { status = 200, method = 'GET', binary = false, text = false } = {}) {
  return limited(async () => {
    requests++;
    const response = await fetch(path(route, params), { method, headers: { Cookie: 'magic_cookie=nom_nom_nom' }, redirect: 'manual', signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, status, `${method} ${route}: expected HTTP ${status}, received ${response.status}`);
    const limit = binary ? 6 * 1024 * 1024 : 3 * 1024 * 1024;
    assert.ok(Number(response.headers.get('content-length') || 0) <= limit, `${route}: response exceeds size limit`);
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        assert.ok(size <= limit, `${route}: streamed response exceeds size limit`);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const decoded = binary ? null : new TextDecoder().decode(bytes);
    const value = binary ? bytes : text ? decoded : JSON.parse(decoded);
    return { value, headers: response.headers };
  });
}

async function check(name, run) {
  const time = Date.now();
  try {
    const detail = await run();
    checks.push({ check: name, ok: true, ms: Date.now() - time, ...detail });
    return detail;
  } catch (error) {
    checks.push({ check: name, ok: false, ms: Date.now() - time, error: error.message });
    return null;
  }
}

function episodeMarker(name) {
  const stem = String(name).normalize('NFKC').replace(/\.(?:ass|ssa|srt|vtt|smi|sami|zip|7z|rar)$/i, '');
  const range = /(?:^|[^\d])(\d{1,3})\s*[~～〜–-]\s*(\d{1,3})(?:\s*(?:화|話|회))?(?=$|[\s._\])])/i.exec(stem);
  if (range && Number(range[1]) < Number(range[2])) return { range: [Number(range[1]), Number(range[2])] };
  for (const pattern of [/\bS\d{1,2}[._ -]*E(\d{1,3})(?!\d)/i,
    /(?:^|\D)(\d{1,3})\s*(?:화|話|회)(?:\D|$)/,
    /(?:^|[^a-z\d])(?:episode|ep|e)[ ._-]*(\d{1,3})(?!\d)/i]) {
    const match = pattern.exec(stem);
    if (match) return { episode: Number(match[1]) };
  }
  const bare = stem.replace(/\[([^\]]*)\]|\([^)]*\)/g, (_, value) => /^\d{1,3}$/.test(value || '') ? ` ${value} ` : ' ')
    .replace(/\b(?:\d{3,4}p|x26[45]|h26[45]|HEVC|AVC|BD|WEB|END)\b/gi, '').trim();
  const trailing = /(?:^|[\s._-])(\d{1,3})(?:v\d+)?[\s._-]*$/i.exec(bare);
  return trailing ? { episode: Number(trailing[1]) } : {};
}

function assertEpisode(name, expected) {
  const marker = episodeMarker(name);
  if (marker.episode != null) assert.equal(marker.episode, expected, `Wrong episode in filename: ${name}`);
  if (marker.range) assert.ok(expected >= marker.range[0] && expected <= marker.range[1], `Episode outside bundle: ${name}`);
}

function downloadCandidates(data, episode) {
  assert.ok(Array.isArray(data.candidates), 'Missing candidate list.');
  const files = data.candidates.filter(item => item.download_url);
  assert.ok(files.length > 0, `No real downloadable candidate (${data.status}; ${(data.warnings || []).slice(0, 2).join(' / ')})`);
  for (const file of files) {
    if (file.episode != null) assert.equal(Number(file.episode), episode, `Wrong candidate episode for ${file.file_name}`);
    assertEpisode(file.file_name, Number(file.matched_episode || file.source_episode || episode));
  }
  return files;
}

async function verifyFile(candidate, requestedEpisode) {
  const expectedEpisode = Number(candidate.matched_episode || candidate.source_episode || requestedEpisode);
  const key = `${candidate.download_url}:${expectedEpisode}`;
  if (inspected.has(key)) return inspected.get(key);
  const task = (async () => {
    const params = { url: candidate.download_url, name: candidate.file_name, language: candidate.language || 'ko', mode: 'inspect' };
    let info = (await request('/api/file', params)).value;
    let archiveEntries = null;
    if (info.archive) {
      assert.equal(info.archive, 'zip', 'Acceptance fixture must offer a directly inspectable subtitle or ZIP.');
      assert.ok(Array.isArray(info.entries) && info.entries.length, 'ZIP contains no supported entries.');
      archiveEntries = info.entries.length;
      const subtitles = info.entries.filter(entry => !entry.font && /\.(?:ass|ssa|srt|vtt|smi|sami)$/i.test(entry.name));
      const exact = subtitles.filter(entry => episodeMarker(entry.name).episode === expectedEpisode);
      const selected = exact[0] || (subtitles.length === 1 && !episodeMarker(subtitles[0].name).episode
        && !episodeMarker(subtitles[0].name).range ? subtitles[0] : null);
      assert.ok(selected, `ZIP has no unambiguous subtitle for episode ${expectedEpisode}.`);
      assertEpisode(selected.name, expectedEpisode);
      params.entry = selected.index;
      info = (await request('/api/file', params)).value;
    }
    assert.equal(info.valid, true, 'Downloaded file failed subtitle validation.');
    assert.ok(Number(info.cue_count) > 0, 'Downloaded file has no dialogue.');
    assert.ok(['srt', 'vtt', 'ass', 'smi'].includes(info.format), `Unexpected subtitle format: ${info.format}`);
    assertEpisode(info.filename, expectedEpisode);
    const [original, utf8] = await Promise.all([
      request('/api/file', { ...params, mode: 'original' }, { binary: true }),
      request('/api/file', { ...params, mode: 'utf8' }, { binary: true }),
    ]);
    for (const result of [original, utf8]) {
      assert.match(result.headers.get('content-disposition') || '', /^attachment;/i);
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(result.value.byteLength > 0, 'Empty file response.');
    }
    assert.equal(original.value.byteLength, info.size, 'Original file size differs from inspection.');
    new TextDecoder('utf-8', { fatal: true }).decode(utf8.value);
    const options = { filename: info.filename, language: candidate.language || 'ko' };
    const originalInfo = inspectSubtitle(original.value, options);
    const utf8Info = inspectSubtitle(utf8.value, options);
    assert.equal(originalInfo.valid, true, 'Original response is not a valid subtitle.');
    assert.equal(utf8Info.valid, true, 'UTF8 response is not a valid subtitle.');
    assert.equal(originalInfo.cue_count, info.cue_count, 'Original dialogue count differs from inspection.');
    assert.equal(originalInfo.text, utf8Info.text, 'UTF8 copy changes subtitle content.');
    return { filename: info.filename, episode: expectedEpisode, format: info.format, encoding: info.encoding,
      cues: info.cue_count, originalBytes: original.value.byteLength, utf8Bytes: utf8.value.byteLength,
      sha256: createHash('sha256').update(original.value).digest('hex').slice(0, 16), ...(archiveEntries == null ? {} : { archiveEntries }) };
  })();
  inspected.set(key, task);
  try { return await task; }
  catch (error) { inspected.delete(key); throw error; }
}

async function verifySearch(params, { fallbackTitle = '' } = {}) {
  let data = (await request('/api/subtitles', params)).value;
  let usedQuery = params.q;
  // A missing unique Korean alias is an allowed lookup limitation. It must
  // still resolve through the discovered native title to real subtitle files.
  if (!data.candidates?.some(item => item.download_url) && fallbackTitle && fallbackTitle !== params.q) {
    usedQuery = fallbackTitle;
    data = (await request('/api/subtitles', { ...params, q: fallbackTitle })).value;
  }
  const candidates = downloadCandidates(data, Number(params.episode));
  const failures = [];
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const file = await verifyFile(candidate, Number(params.episode));
      return { query: usedQuery, candidates: candidates.length, cache: data.cache || null, warnings: (data.warnings || []).slice(0, 2), file };
    } catch (error) { failures.push(error.message); }
  }
  throw new Error(`No inspectable subtitle among the first ${Math.min(3, candidates.length)} candidates: ${failures.join(' / ')}`);
}

const health = await check('release-and-assets', async () => {
  const [status, page, app] = await Promise.all([
    request('/api/health'), request('/', {}, { text: true }), request('/app.js', {}, { text: true }),
  ]);
  assert.equal(status.value.status, 'ok');
  assert.equal(status.value.version, expectedVersion, 'Deployment version differs from expected release.');
  for (const label of ['Jimaku 파일 찾기', '저장 결과 대신 새로 검색', 'Drive 폴더']) assert.ok(page.value.includes(label), `Missing UI label: ${label}`);
  for (const label of ['내용 확인 · 저장', 'UTF-8 사본 저장', 'subfinder-files-v1']) assert.ok(app.value.includes(label), `Missing file workflow: ${label}`);
  return { version: status.value.version };
});

if (health) {
  await check('invalid-request-guards', async () => {
    await Promise.all([
      request('/api/subtitles', { source: 'unknown', q: 'Example' }, { status: 400 }),
      request('/api/subtitles', { source: 'anissia', q: 'Example' }, { status: 405, method: 'POST' }),
      request('/api/file', { url: 'https://127.0.0.1/private.srt', mode: 'inspect' }, { status: 400 }),
    ]);
    return { statuses: [400, 405, 400] };
  });

  const works = await Promise.all([
    { title: '책벌레의 하극상', id: 3291, episodes: [1, 24] },
    { title: '아가씨 돌보기', id: 3435, episodes: [1, 12] },
  ].map(async work => {
    let selected;
    await check(`discover:${work.title}`, async () => {
      const fresh = (await request('/api/anime', { q: work.title, refresh: 1 })).value;
      assert.ok(Array.isArray(fresh.anime), 'Missing discovery list.');
      selected = fresh.anime.find(item => Number(item.anime_no ?? item.animeNo) === work.id);
      assert.ok(selected, `Expected Anissia work ${work.id} is absent.`);
      const repeated = (await request('/api/anime', { q: work.title })).value;
      assert.ok(repeated.anime.some(item => Number(item.anime_no ?? item.animeNo) === work.id), 'Cached discovery lost the selected work.');
      return { count: fresh.anime.length, selected: selected.subject, animeNo: work.id,
        cache: { fresh: fresh.cache || null, repeated: repeated.cache || null } };
    });
    return selected ? { ...work, selected } : null;
  }));

  const tasks = [];
  for (const work of works.filter(Boolean)) {
    for (const episode of work.episodes) tasks.push(() => check(`ko:${work.id}:${episode}`, () => verifySearch({
      source: 'anissia', q: work.selected.subject, animeNo: work.id, episode,
    })));
    // The latest Bookworm season and both ends of the maid series cover the
    // Japanese lookup without repeating the large Jimaku index unnecessarily.
    for (const episode of work.id === 3291 ? [1] : [1, 12]) tasks.push(() => check(`ja:${work.id}:${episode}`, () => verifySearch({
      source: 'jimaku', q: work.selected.subject, episode,
    }, { fallbackTitle: work.selected.original_subject || '' })));
  }
  // Three workflows at most; the shared request limiter also caps nested
  // original/UTF8 downloads at three active HTTP requests in total.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));

  if (args.includes('--first-season')) await check('bookworm-first-season-no-sequel', async () => {
    const data = (await request('/api/subtitles', { source: 'anissia', q: '책벌레의 하극상', animeNo: 1576, episode: 1 })).value;
    assert.ok(Array.isArray(data.candidates), 'Missing first-season candidate list.');
    for (const candidate of data.candidates) {
      assert.doesNotMatch(`${candidate.title} ${candidate.file_name}`, /영주의\s*양녀|領主の養女/, 'Sequel leaked into first-season results.');
      if (candidate.download_url) assertEpisode(candidate.file_name, Number(candidate.matched_episode || 1));
    }
    return { candidates: data.candidates.length, status: data.status, warnings: (data.warnings || []).slice(0, 2) };
  });
}

const failures = checks.filter(item => !item.ok);
console.log(JSON.stringify({ base: base.origin, version: expectedVersion, ok: failures.length === 0,
  checks: checks.length, failed: failures.length, requests, durationMs: Date.now() - started, results: checks }));
if (failures.length) process.exitCode = 1;
