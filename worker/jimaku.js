import { loadEpisodeRelations, verifiedEpisodeAlternatives } from './episode-matching.js';

const JIMAKU_ORIGIN = 'https://jimaku.cc';
const FORMATS = { ass: 100, ssa: 96, srt: 90, vtt: 86, smi: 84, sami: 84 };
const caches = new WeakMap();
const INDEX_TTL = 6 * 60 * 60 * 1000;
const MISS_TTL = 10 * 60 * 1000;

function cacheFor(fetcher) {
  if (!caches.has(fetcher)) caches.set(fetcher, { index: null, indexPending: null, files: new Map(), pending: new Map() });
  return caches.get(fetcher);
}

function decodeHtml(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, entity) => {
    if (entity[0] !== '#') return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[entity.toLowerCase()] || all;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

function attributes(value) {
  const out = {};
  for (const match of value.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
  return out;
}

function rows(html) {
  const out = [];
  for (const match of html.matchAll(/<div\b([^>]*\bdata-extra\s*=[^>]*)>([\s\S]*?)<\/div>/gi)) {
    const at = attributes(match[1]);
    if (!/(?:^|\s)entry(?:\s|$)/.test(at.class || '') || !at['data-extra']) continue;
    let extra;
    try { extra = JSON.parse(at['data-extra']); } catch { continue; }
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(match[2]);
    out.push({ extra, href: attributes(anchor?.[1] || '').href || '', text: decodeHtml((anchor?.[2] || '').replace(/<[^>]*>/g, '')).trim() });
  }
  return out;
}

async function publicText(url, fetcher, limit = 8 * 1024 * 1024) {
  const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html', 'User-Agent': 'SubtitleFinder/1.0' } });
  if (!response.ok) throw new Error(`Jimaku 응답 오류 (${response.status})`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Jimaku 응답이 너무 큽니다.');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let length = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Jimaku 응답이 너무 큽니다.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export function parseJimakuIndex(html) {
  const entries = new Map();
  for (const { extra, href, text } of rows(html)) {
    const entry = /^\/entry\/(\d+)\/?$/.exec(href)?.[1];
    const id = Number(extra.anilist_id);
    if (!entry || !Number.isSafeInteger(id) || id < 1) continue;
    entries.set(entry, { entry, anilistId: id, title: String(extra.name || text), aliases: [extra.name || text, extra.english_name, extra.japanese_name].filter(value => typeof value === 'string' && value.trim()) });
  }
  return [...entries.values()];
}

export function parseJimakuFiles(html, entry) {
  const files = new Map();
  for (const { extra, href, text } of rows(html)) {
    const name = String(extra.name || text).trim();
    if (!FORMATS[name.split('.').pop().toLowerCase()]) continue;
    let url;
    try { url = new URL(extra.url || href, `${JIMAKU_ORIGIN}/entry/${entry}`); } catch { continue; }
    if (url.origin !== JIMAKU_ORIGIN || url.username || url.password || !url.pathname.startsWith(`/entry/${entry}/download/`)) continue;
    if (!files.has(url.href)) files.set(url.href, { name, url: url.href, size: Math.max(0, Number(extra.size) || 0) });
  }
  return [...files.values()];
}

async function index(fetcher, refresh) {
  const cache = cacheFor(fetcher);
  if (!refresh && cache.index && Date.now() - cache.index.at < INDEX_TTL) return { entries: cache.index.entries, stale: false };
  if (!cache.indexPending) cache.indexPending = (async () => {
    try {
      const entries = parseJimakuIndex(await publicText(`${JIMAKU_ORIGIN}/`, fetcher));
      if (!entries.length) throw new Error('Jimaku 작품 목록을 읽지 못했습니다.');
      cache.index = { at: Date.now(), entries };
      return { entries, stale: false };
    } catch (error) {
      if (!refresh && cache.index && Date.now() - cache.index.at < 7 * 86400000) return { entries: cache.index.entries, stale: true };
      throw error;
    } finally { cache.indexPending = null; }
  })();
  return cache.indexPending;
}

async function entryFiles(entry, fetcher, refresh) {
  const cache = cacheFor(fetcher), hit = cache.files.get(entry);
  if (!refresh && hit && Date.now() - hit.at < MISS_TTL) return hit.files;
  if (!cache.pending.has(entry)) cache.pending.set(entry, (async () => {
    try {
      const files = parseJimakuFiles(await publicText(`${JIMAKU_ORIGIN}/entry/${entry}`, fetcher), entry);
      cache.files.set(entry, { at: Date.now(), files });
      if (cache.files.size > 32) cache.files.delete(cache.files.keys().next().value);
      return files;
    } finally { cache.pending.delete(entry); }
  })());
  return cache.pending.get(entry);
}

const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function seasonNumber(value) {
  const match = /\b(?:season\s*|s)(\d{1,2})(?:\b|e\d)|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|(?:제\s*)?(\d{1,2})\s*[기期]|\bpart\s*(\d{1,2})\b/i.exec(String(value).normalize('NFKC'));
  return match ? Number(match.slice(1).find(Boolean)) : null;
}

export function parseFileEpisode(name) {
  const text = String(name).normalize('NFKC').replace(/\.[^.]+$/, '');
  const season = /(?:^|[^a-z\d])S(\d{1,2})[ ._-]*E\d/i.exec(text)?.[1];
  const range = /(?:^|[^a-z\d])(?:s\d{1,2}e|ep?\s*)?(\d{1,3})\s*[-~〜–—]\s*(?:s\d{1,2}e|ep?\s*)?(\d{1,3})(?=$|[^\d])/i.exec(text);
  if (range && Number(range[1]) < Number(range[2])) return { season: season ? Number(season) : null, range: [Number(range[1]), Number(range[2])], episode: null, score: 45 };
  for (const [pattern, score] of [[/(?:^|[^a-z\d])S\d{1,2}[ ._-]*E(\d{1,3})(?!\d)/i, 65], [/(?:^|[^a-z\d])(?:episode|ep|e)[ ._-]*0*(\d{1,3})(?!\d)/i, 58], [/(?:^|\D)(\d{1,3})\s*[화회話](?:\D|$)/, 55]]) {
    const match = pattern.exec(text);
    if (match) return { season: season ? Number(season) : null, episode: Number(match[1]), range: null, score };
  }
  const bare = text.replace(/\[([^\]]*)\]|\([^)]*(?:\d{3,4}p|x26[45]|HEVC|AVC)[^)]*\)/gi, (_, contents) => /^\d{1,3}$/.test(contents || '') ? ` ${contents} ` : ' ').replace(/\b(?:\d{3,4}p|x26[45]|h\.?26[45]|\d+bit)\b/gi, ' ');
  const numbers = [...bare.matchAll(/(?:^|[\s._-])(\d{1,3})(?=$|[\s._-])/g)];
  return { season: null, episode: numbers.length ? Number(numbers.at(-1)[1]) : null, range: null, score: 50 };
}

function release(name) {
  const lower = String(name || '').toLowerCase();
  return { ext: lower.split('.').pop(), group: /^\s*[[【(]([^\]】)]+)[\]】)]/.exec(lower)?.[1] || '', words: new Set(lower.replace(/\.[^.]+$/, '').replace(/\[[\da-f]{8}\]/g, '').replace(/\d+/g, '#').split(/[^\p{L}\p{N}#]+/u).filter(Boolean)) };
}

export function jimakuLikeness(a, b) {
  const x = release(a), y = release(b);
  return [...x.words].filter(word => y.words.has(word)).length / (new Set([...x.words, ...y.words]).size || 1) + (x.group && x.group === y.group ? 0.5 : 0) + (x.ext === y.ext ? 0.2 : 0);
}

export function rankEpisodeFiles(files, { episode = null, season = null, preferredFile = '', alternatives = [] } = {}) {
  const maximum = Math.max(0, ...files.map(file => {
    const parsed = parseFileEpisode(file.name);
    return season && parsed.season && season !== parsed.season ? 0 : parsed.range?.[1] || parsed.episode || 0;
  }));
  const eligible = files.map(file => {
    const parsed = parseFileEpisode(file.name);
    if (season && parsed.season && season !== parsed.season) return null;
    const matches = ep => parsed.range ? ep >= parsed.range[0] && ep <= parsed.range[1] : parsed.episode === ep;
    let matchedEpisode = episode, alternate = false;
    if (episode != null && !matches(episode)) {
      const alt = alternatives.find(item => matches(item.episode) && (!parsed.range || parsed.range[1] <= item.limit)
        && (!item.minimum || (maximum <= item.limit && (!parsed.range || parsed.range[0] >= item.minimum))));
      if (!alt) return null;
      matchedEpisode = alt.episode; alternate = true;
    }
    const quality = FORMATS[file.name.split('.').pop().toLowerCase()] || 0;
    return { ...file, matchedEpisode, alternate, bundle: Boolean(parsed.range), rank: quality + (episode == null ? 0 : parsed.score), likeness: preferredFile ? jimakuLikeness(file.name, preferredFile) : 0 };
  }).filter(Boolean);
  return eligible.sort((a, b) => Number(a.alternate) - Number(b.alternate) || Number(b.likeness >= 0.8) - Number(a.likeness >= 0.8) || (b.likeness >= 0.8 ? b.likeness - a.likeness : 0) || b.rank - a.rank || a.name.localeCompare(b.name));
}

export function jimakuSearchUrl(q) {
  const url = new URL('/opensearch/redirect', JIMAKU_ORIGIN);
  url.searchParams.set('anime', 'true');
  url.searchParams.set('query', String(q ?? '').trim());
  return url.toString();
}

function fallback(title, warnings, status = 'review') {
  return { status, warnings, candidates: [{ provider: 'Jimaku', title, file_name: 'Jimaku에서 직접 검색', source_url: jimakuSearchUrl(title), download_url: '', language: 'ja', season: null, episode: null, confidence: 'review', note: '일본어 자막입니다. 영문·로마자·일본어 제목으로 사이트에서 확인해 주세요.' }] };
}

export async function searchJimaku({ q, aliases = [], season = null, episode = null, anilistId = null, preferredFile = '', refresh = false } = {}, fetcher = fetch) {
  const title = typeof q === 'string' ? q.trim() : '';
  if (!title) return { status: 'error', warnings: ['검색할 제목을 입력해 주세요.'], candidates: [] };
  const warnings = [];
  try {
    const wantedSeason = season ?? seasonNumber(title);
    const names = [title, ...(Array.isArray(aliases) ? aliases.slice(0, 8) : [])].filter(name => typeof name === 'string' && name.length <= 400).map(normalized).filter(Boolean);
    const exactName = item => item.aliases.some(alias => names.includes(normalized(alias)));
    const choose = entries => entries.filter(item => {
      if (anilistId) return item.anilistId === Number(anilistId);
      if (wantedSeason && (seasonNumber(item.title) || 1) !== wantedSeason) return false;
      if (!/\b(?:ova|oad|special)\b/i.test(title) && /\b(?:ova|oad|special)\b/i.test(item.title)) return false;
      return item.aliases.some(alias => { const name = normalized(alias); return names.some(wanted => name === wanted || (wanted.length >= 4 && name.includes(wanted))); });
    }).sort((a, b) => Number(exactName(b)) - Number(exactName(a)));
    const loaded = await index(fetcher, refresh);
    if (loaded.stale) warnings.push('Jimaku 갱신에 실패해 이전 작품 목록을 사용했습니다.');
    let entries = choose(loaded.entries);
    if (!entries.length && !refresh && Date.now() - cacheFor(fetcher).index.at > MISS_TTL) entries = choose((await index(fetcher, true)).entries);
    if (!entries.length) return fallback(title, ['Jimaku에서 일치하는 작품을 찾지 못했습니다. 영문·로마자·일본어 제목이나 AniList ID를 확인해 주세요.']);
    const exact = entries.filter(exactName);
    if (exact.length) entries = exact;
    if (entries.length > 1) warnings.push('여러 작품이 일치합니다. 파일의 작품명과 시즌을 확인해 주세요.');
    const candidates = [];
    let upstreamFailed = false;
    for (const entry of entries.slice(0, 4)) {
      try {
        const files = await entryFiles(entry.entry, fetcher, refresh);
        let ranked = rankEpisodeFiles(files, { episode, season: wantedSeason, preferredFile });
        if (episode != null && !ranked.length) {
          const relations = await loadEpisodeRelations(entry.anilistId, fetcher, { refresh }).catch(() => null);
          ranked = rankEpisodeFiles(files, { episode, season: wantedSeason, preferredFile, alternatives: verifiedEpisodeAlternatives(episode, relations) });
        }
        for (const file of ranked.slice(0, 80)) {
          const confidence = entries.length === 1 && (anilistId || exactName(entry)) && episode != null && !file.bundle && !file.alternate ? 'exact' : 'review';
          candidates.push({ provider: 'Jimaku', title: entry.title, file_name: file.name, source_url: `${JIMAKU_ORIGIN}/entry/${entry.entry}`, download_url: file.url, language: 'ja', season: wantedSeason, episode, matched_episode: file.matchedEpisode, anilist_id: entry.anilistId, confidence, require_episode: confidence !== 'exact', note: `일본어 자막${file.alternate ? ` · AniList에서 확인한 회차 표기 ${episode} → ${file.matchedEpisode}화 후보 (확인 필요)` : ''}${file.bundle ? ' · 여러 회차가 포함된 파일' : ''}${file.likeness >= 0.8 ? ' · 이전에 선택한 배포본과 유사' : ''}` });
        }
      } catch (error) { upstreamFailed = true; warnings.push(error.message); }
    }
    if (!candidates.length) return fallback(title, [...warnings, '해당 회차의 자막 파일을 찾지 못했습니다.'], upstreamFailed ? 'error' : 'review');
    return { status: candidates.some(item => item.confidence === 'exact') ? 'ok' : 'review', warnings, candidates };
  } catch (error) { return fallback(title, [error.message || 'Jimaku 검색에 실패했습니다.'], 'error'); }
}
