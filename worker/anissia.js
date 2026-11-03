// Public Anissia creator posts. This module only requests known HTTPS hosts and
// returns verified source links; it never proxies an arbitrary URL or file.
import { directoryCaptions } from './blog-directory.js';
import { driveFolderId, listDriveFolder } from './drive.js';
import { cachedValue } from './cache.js';
import { resolveAniListId, loadEpisodeRelations, verifiedEpisodeAlternatives } from './episode-matching.js';

const ANISSIA = 'https://api.anissia.net';
const SUBTITLE_EXT = /\.(?:srt|smi|sami|vtt|ass|ssa|zip|7z|rar)(?:$|[?#])/i;
const SPECIAL = /(?:^|[^a-z])(?:OVA|OAD|SP|SPECIAL|CHRISTMAS|NCOP|NCED)(?=$|[^a-z])|특전|외전|특별편/i;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function hostAllowed(host) {
  if (['api.anissia.net', 'blog.naver.com', 'm.blog.naver.com', 'rss.blog.naver.com',
    'download.blog.naver.com', 'blogfiles.pstatic.net', 'blog.kakaocdn.net',
    'drive.google.com'].includes(host)) return true;
  const parts = host.split('.');
  return parts.length === 3 && ['blogspot.com', 'tistory.com'].includes(parts.slice(1).join('.'))
    && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(parts[0]);
}

function safeUrl(input, base) {
  try {
    const url = new URL(input, base);
    if (url.protocol === 'http:' && !url.username && !url.password && !url.port && hostAllowed(url.hostname)) {
      url.protocol = 'https:';
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !hostAllowed(url.hostname)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function blogKind(url) {
  if (['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) return 'naver';
  if (url.hostname.endsWith('.tistory.com')) return 'tistory';
  if (url.hostname.endsWith('.blogspot.com')) return 'blogger';
  return null;
}

function driveLink(input) {
  const url = safeUrl(input);
  if (!url || url.hostname !== 'drive.google.com') return null;
  const id = /^\/file\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1]
    || (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
  return id && /^[\w-]+$/.test(id) ? url.href : null;
}

function decodeHtml(value) {
  return String(value || '').replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return names[entity.toLowerCase()] || _;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
  });
}

function attrs(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function plain(html) {
  return decodeHtml(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function documentInfo(html) {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attrs(match[0]));
  const title = meta.find(item => (item.property || item.name || '').toLowerCase() === 'og:title')?.content
    || plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => {
    const at = attrs(match[1]);
    return { href: at.href || '', text: plain(match[2]), download: at.download || '', at };
  });
  // Several Tistory themes make the entire search card clickable.
  for (const match of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const at = attrs(match[1]);
    const target = /^\s*window\.open\(\s*(['"])(.*?)\1\s*,\s*(['"])_self\3\s*\)\s*;?\s*$/.exec(at.onclick || '');
    if (target) links.push({ href: target[2], text: plain(match[2]).replace(/^\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*/, ''), download: '', at });
  }
  return { title, links };
}

function episodeOf(text) {
  const value = String(text || '').normalize('NFKC');
  for (const pattern of [/\bS\d{1,2}[ ._-]*E(\d{1,3})\b/i,
    /(?:^|\D)(?:제\s*)?(\d{1,3})\s*(?:화|話|회)(?:\D|$)/i,
    /(?:^|[\s._\[(#-])(?:EP?|#)\s*0*(\d{1,3})(?=[\s._\])#-]|$)/i]) {
    const match = pattern.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

function episodeRange(text) {
  const match = /(?:^|\D)(\d{1,3})\s*[~～〜\-–]\s*(\d{1,3})\s*(?:화|話|회|완결|자막|$)/i.exec(String(text || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function seasonOf(text) {
  const value = String(text || '').normalize('NFKC');
  const match = /(?:\b(?:season|시즌)\s*|[제第]\s*)?(\d{1,2})\s*(?:기|期)(?!\w)|\b(?:season|시즌)\s*(\d{1,2})\b|\bS(\d{1,2})[ ._-]*E\d{1,3}\b/i.exec(value);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

function matchTitle(postTitle, aliases, season, episode) {
  if (typeof postTitle !== 'string' || !postTitle) return 'none';
  const title = postTitle.normalize('NFKC').replace(/^\s*\[(?:자막|Erai-raws|Ohys-Raws|SubsPlease|Moozzi2|Snow-Raws)\]\s*/i, '');
  if (!aliases.some(alias => SPECIAL.test(alias)) && SPECIAL.test(title.replace(/\bTV\s*\+\s*(?:OVA|OAD|SP)\b/ig, 'TV'))) return 'none';
  const statedSeason = seasonOf(title);
  if (season && statedSeason && season !== statedSeason) return 'none';
  const range = episodeRange(title);
  const statedEpisode = episodeOf(title);
  if (episode != null && ((range && (episode < range[0] || episode > range[1]))
    || (!range && statedEpisode !== episode))) return 'none';
  const prefix = title.split(/(?:\d{1,3}\s*[~～〜–-]\s*\d{1,3}\s*(?:화|話|회)|\d{1,3}\s*(?:화|話|회)|\bS\d{1,2}[ ._-]*E\d{1,3}\b|자막)/i, 1)[0]
    .replace(/(?:\s+(?:BD|TV|블루레이|전체|통합|완결|한글|한국어))+\s*$/i, '').trim();
  const needle = normalized(prefix);
  const names = aliases.map(normalized).filter(name => name.length >= 2);
  if (!needle || !names.includes(needle)) return 'none';
  return episode != null && statedEpisode === episode && names.includes(needle) && !range ? 'exact' : 'review';
}

function candidate(provider, title, fileName, sourceUrl, downloadUrl, query, creator, confidence, note = '') {
  return {
    provider, title, file_name: fileName, source_url: sourceUrl, download_url: downloadUrl,
    language: 'ko', season: query.season ?? seasonOf(title),
    episode: query.episode ?? episodeOf(title), confidence, creator, note,
    require_episode: confidence !== 'exact',
  };
}

function fileNameOf(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; }
}

function goodFile(name, requestedEpisode) {
  if (!SUBTITLE_EXT.test(name)) return false;
  if (requestedEpisode == null) return true;
  const found = episodeOf(name) || Number(/(?:^|[\s._-])(\d{1,3})(?:\.[a-z0-9]+)?$/i.exec(name.replace(SUBTITLE_EXT, ''))?.[1] || 0);
  return !found || found === requestedEpisode || /\.(?:zip|7z|rar)$/i.test(name);
}

function sanitizeQuery(raw) {
  const q = String(raw.q || '').trim();
  if (!q || q.length > 150 || /[\u0000-\u001f]/.test(q)) throw new Error('작품명을 확인해 줘');
  const season = raw.season == null || raw.season === '' ? null : Number(raw.season);
  const episode = raw.episode == null || raw.episode === '' ? null : Number(raw.episode);
  if (season != null && (!Number.isInteger(season) || season < 1 || season > 99)) throw new Error('시즌 번호가 올바르지 않음');
  if (episode != null && (!Number.isInteger(episode) || episode < 1 || episode > 999)) throw new Error('화수가 올바르지 않음');
  return { q, season, episode, refresh: Boolean(raw.refresh) };
}

class RequestContext {
  constructor(fetcher, remaining = 42, refresh = false) {
    // Workers' global fetch must be called with its original binding.
    this.fetcher = (...args) => fetcher(...args);
    this.remaining = remaining;
    this.namespace = fetcher;
    this.refresh = refresh;
    this.deadline = Date.now() + 35_000;
    this.folders = new Map();
  }

  async get(input, format = 'text') {
    const key = safeUrl(input)?.href;
    if (!key) throw new Error('지원하는 HTTPS 출처가 아님');
    const { value, cache } = await cachedValue(`page:${format}:${key}`, () => this.getUncached(key, format), {
      namespace: this.namespace, refresh: this.refresh, maxEntries: 48,
    });
    if (cache === 'stale') this.stale = true;
    return value;
  }

  async getUncached(input, format = 'text') {
    let url = safeUrl(input);
    if (!url) throw new Error('지원하는 HTTPS 출처가 아님');
    for (let redirect = 0; redirect < 4; redirect++) {
      if (Date.now() >= this.deadline) { this.remaining = 0; throw new Error('검색 시간 제한에 도달함'); }
      if (this.remaining-- <= 0) throw new Error('요청 횟수 제한에 도달함');
      const response = await this.fetcher(url.href, {
        method: 'GET', redirect: 'manual', headers: { Accept: format === 'json' ? 'application/json' : 'text/html,*/*' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(12000, this.deadline - Date.now()))),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        url = location ? safeUrl(location, url.href) : null;
        await response.body?.cancel();
        if (!url) throw new Error('허용되지 않은 주소로 이동함');
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url.hostname}`);
      const limit = format === 'json' ? MAX_JSON : MAX_HTML;
      const length = Number(response.headers.get('content-length') || 0);
      if (length > limit) throw new Error('응답 크기 제한 초과');
      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) { await reader.cancel(); throw new Error('응답 크기 제한 초과'); }
          chunks.push(value);
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > limit) throw new Error('응답 크기 제한 초과');
        bytes = new Uint8Array(buffer);
      }
      const text = new TextDecoder('utf-8').decode(bytes);
      if (format !== 'json') return text;
      try { return JSON.parse(text); } catch { throw new Error('JSON 응답을 읽지 못함'); }
    }
    throw new Error('리디렉션 횟수 제한 초과');
  }
}

function unique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.provider}:${item.source_url}:${item.download_url}:${item.file_name}:${item.episode ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function result(candidates, warnings = []) {
  const list = unique(candidates).sort((a, b) => Number(b.confidence === 'exact') - Number(a.confidence === 'exact'));
  return { candidates: list, warnings, status: list.length ? (list.some(c => c.confidence === 'exact') ? 'found' : 'review') : warnings.length ? 'error' : 'empty' };
}

export async function discoverAnime(term, fetcher = fetch, { refresh = false } = {}) {
  const q = String(term || '').trim();
  if (!q || q.length > 150 || /[\u0000-\u001f]/.test(q)) {
    return { anime: [], warnings: ['검색어를 입력해 줘'], status: 'error' };
  }
  const context = new RequestContext(fetcher, 22, refresh);
  const anime = new Map();
  const warnings = [];
  let pages = 1;
  for (let page = 0; page < Math.min(pages, 20); page++) {
    try {
      const url = `${ANISSIA}/anime/list/${page}?${new URLSearchParams({ q })}`;
      const body = await context.get(url, 'json');
      if (body?.code !== undefined && body.code !== 'ok') throw new Error('애니시아 작품 검색 응답 오류');
      const data = body?.data;
      if (!Array.isArray(data?.content) || !Number.isInteger(data?.totalPages) || data.totalPages < 0) {
        throw new Error('애니시아 작품 검색 응답 형식 오류');
      }
      if (page === 0) {
        pages = data.totalPages;
        if (pages > 20) warnings.push('애니시아 검색 결과는 처음 20페이지만 확인함');
      }
      for (const item of data.content) {
        if (!Number.isInteger(item?.animeNo) || item.animeNo <= 0 || typeof item.subject !== 'string') continue;
        const original = typeof item.originalSubject === 'string' ? item.originalSubject : '';
        if (normalized(item.subject).includes(normalized(q)) || normalized(original).includes(normalized(q))) {
          anime.set(item.animeNo, { anime_no: item.animeNo, subject: item.subject, original_subject: original });
        }
      }
    } catch (error) {
      warnings.push(`애니시아 작품 검색 ${page + 1}페이지: ${error.message}`);
      break;
    }
  }
  if (context.stale) warnings.push('외부 사이트 갱신에 실패해 이전 작품 목록을 사용했습니다.');
  return { anime: [...anime.values()], warnings, status: anime.size ? 'found' : warnings.length ? 'error' : 'empty' };
}

function postAliases(q) {
  const aliases = [q];
  const shortened = /^(.*?)\s+(?:[-–—:]|[~～〜]+)\s*[^~～〜]+/.exec(q)?.[1]?.trim();
  if (shortened && normalized(shortened).length >= 4 && !seasonOf(q.slice(shortened.length))
    && !SPECIAL.test(q.slice(shortened.length))) aliases.push(shortened);
  return aliases;
}

function naverPostUrl(input) {
  const url = safeUrl(input);
  if (!url || !['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) return null;
  const path = url.pathname.split('/').filter(Boolean);
  const blog = url.searchParams.get('blogId') || path[0];
  const post = url.searchParams.get('logNo') || path[1];
  return /^[\w-]+$/.test(blog || '') && /^\d+$/.test(post || '')
    ? `https://blog.naver.com/${blog}/${post}` : null;
}

function naverBlogId(source) {
  const blog = source.searchParams.get('blogId') || source.pathname.split('/').filter(Boolean)[0];
  return /^[\w-]+$/.test(blog || '') ? blog : null;
}

function directAttachments(html, postUrl, title, aliases, query, creator, provider) {
  const confidence = matchTitle(title, aliases, query.season, query.episode);
  if (confidence === 'none') return [];
  const files = [];
  const doc = documentInfo(html);
  for (const link of doc.links) {
    const url = safeUrl(link.href, postUrl);
    if (!url) continue;
    if (provider === 'ReAnime/네이버' && !['download.blog.naver.com', 'blogfiles.pstatic.net'].includes(url.hostname)) continue;
    if (provider === 'ReAnime/티스토리' && url.hostname !== 'blog.kakaocdn.net') continue;
    const name = link.download || (SUBTITLE_EXT.test(link.text) ? link.text : '') || fileNameOf(url.href);
    files.push([name, url.href]);
  }
  if (provider === 'ReAnime/네이버') {
    for (const match of html.matchAll(/aPostFiles\[\d+\]\s*=\s*JSON\.parse\(\s*'((?:\\.|[^'\\])*)'/g)) {
      try {
        const encoded = match[1].replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\([nrt'"\\/])/gi,
          (_, unicode, hex, escaped) => unicode ? String.fromCharCode(parseInt(unicode, 16))
            : hex ? String.fromCharCode(parseInt(hex, 16)) : ({ n: '\n', r: '\r', t: '\t' }[escaped] || escaped));
        const rows = JSON.parse(encoded);
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row?.maliciousCodeYn === 'true' || ![undefined, null, '0'].includes(row?.punishType)) continue;
          const url = safeUrl(row?.encodedAttachFileUrl);
          if (url && ['download.blog.naver.com', 'blogfiles.pstatic.net'].includes(url.hostname)) {
            files.push([decodeURIComponent(row.encodedAttachFileName || fileNameOf(url.href)), url.href]);
          }
        }
      } catch { /* Ignore malformed attachment metadata. */ }
    }
  }
  return files.filter(([name]) => goodFile(name, query.episode) && (SPECIAL.test(query.q) || !SPECIAL.test(name)))
    .map(([name, url]) => candidate(provider, title, name, postUrl, url, query, creator, confidence));
}

function bloggerAttachments(content, title, postUrl, aliases, query, creator) {
  const unnumberedPost = episodeOf(title) == null && !episodeRange(title);
  const confidence = matchTitle(title, aliases, query.season, unnumberedPost ? null : query.episode);
  if (confidence === 'none') return [];
  const files = [];
  for (const link of documentInfo(content).links) {
    const url = driveLink(link.href);
    if (!url || /폰트|서체|글꼴|fonts?|\.ttf|\.otf/i.test(link.text)) continue;
    if (!SPECIAL.test(query.q) && SPECIAL.test(link.text)) continue;
    const labelSeason = seasonOf(link.text);
    if (query.season && labelSeason && query.season !== labelSeason) continue;
    if (query.episode != null) {
      const range = episodeRange(link.text);
      const number = episodeOf(link.text);
      if (unnumberedPost && !range && number == null) continue;
      if ((range && (query.episode < range[0] || query.episode > range[1]))
        || (!range && number != null && number !== query.episode)) continue;
    }
    const name = (link.text || 'Google Drive 자막 (파일 형식 확인 필요)').slice(0, 100);
    files.push({ ...candidate('ReAnime/Blogger', title, name, postUrl, url, query, creator, 'review', 'Drive에서 실제 파일명을 확인해 줘'),
      episode_range: episodeRange(link.text) || episodeRange(title) || undefined });
  }
  if (query.episode != null && confidence === 'exact' && files.length === 1 && !episodeRange(title)) {
    files[0].confidence = 'exact';
    files[0].require_episode = false;
  } else if (query.episode == null) {
    const range = episodeRange(title);
    if (range && range[1] > range[0] && range[1] - range[0] < 50) {
      return files.flatMap(file => Array.from({ length: range[1] - range[0] + 1 }, (_, i) => ({
        ...file, file_name: file.file_name.replace(/(\.[^.]+)$/, ` (${range[0] + i}화)$1`), episode: range[0] + i,
      })));
    }
  }
  return files;
}

async function readPost(context, url, aliases, query, creator, kind) {
  let html = await context.get(url);
  if (kind === 'naver') {
    const frame = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(html);
    const frameUrl = frame ? safeUrl(decodeHtml(frame[1] || frame[2]), url) : null;
    if (frameUrl && naverPostUrl(frameUrl.href) === naverPostUrl(url)) {
      html = await context.get(frameUrl.href);
    }
  }
  const title = documentInfo(html).title;
  return postAttachments(context, html, title, url, aliases, query, creator, kind);
}

async function folderCandidates(context, url, title, aliases, query, creator, trustedTitle = false) {
  const key = JSON.stringify([url, query.q, aliases, trustedTitle, query.season, query.episode]);
  if (!context.folders.has(key)) context.folders.set(key, cachedValue(`drive:${key}`, () => listDriveFolder(url, {
    ...query, aliases, trustedTitle, maxListings: Math.min(6, Math.max(1, context.remaining - 2)),
  }, async (...args) => {
    if (context.remaining-- <= 0 || Date.now() >= context.deadline) throw new Error('Drive 검색 제한에 도달함');
    return context.fetcher(...args);
  }), { namespace: context.namespace, refresh: context.refresh, staleTtl: 300000,
    isSuccess: value => value.files.length > 0 || !value.warnings.length, isEmpty: value => !value.files.length,
  }).then(result => { if (result.cache === 'stale') context.stale = true; return result.value; }));
  const listed = await context.folders.get(key);
  return {
    found: listed.files.map(file => ({
      ...candidate('Google Drive 폴더', title, file.name, url, file.download_url, query, creator, file.confidence,
        '공개 폴더에서 찾은 파일 · 내용 확인 후 저장해 주세요.'),
      episode: query.episode ?? file.episode, episode_range: file.episode_range, fonts: listed.fonts,
    })), warnings: listed.warnings,
  };
}

async function postAttachments(context, html, title, url, aliases, query, creator, kind) {
  const files = kind === 'blogger' ? bloggerAttachments(html, title, url, aliases, query, creator)
    : directAttachments(html, url, title, aliases, query, creator,
      kind === 'naver' ? 'ReAnime/네이버' : 'ReAnime/티스토리');
  if (matchTitle(title, aliases, query.season, episodeOf(title) == null && !episodeRange(title) ? null : query.episode) !== 'none') {
    const links = documentInfo(html).links;
    const fonts = links.map(link => ({ name: link.download || link.text || fileNameOf(link.href), url: safeUrl(link.href, url)?.href }))
      .filter(link => link.url && (/\.(?:ttf|otf|ttc|woff2?)$/i.test(link.name) || driveLink(link.url) && /^(?:폰트|글꼴|서체|fonts?)(?:\s|$)/i.test(link.name))).slice(0, 40);
    for (const file of files) if (fonts.length) file.fonts = fonts;
    const folders = [...new Set(links.map(link => safeUrl(link.href, url)?.href).filter(link => link && driveFolderId(link)))].slice(0, 2);
    for (const folder of folders) {
      try {
        const listed = await folderCandidates(context, folder, title, aliases, query, creator, true);
        files.push(...listed.found);
        if (!listed.found.length) files.push(candidate('Google Drive 폴더', title, '폴더에서 직접 확인', folder, '', query, creator, 'review', listed.warnings.join(' · ')));
      } catch (error) { files.push(candidate('Google Drive 폴더', title, '폴더에서 직접 확인', folder, '', query, creator, 'review', error.message)); }
    }
  }
  if (!files.length && matchTitle(title, aliases, query.season, query.episode) !== 'none'
    && /WinPNG|Jamaker|\.jmk\b|downloadZip/i.test(html)) {
    files.push(candidate('이미지 자막', title, '원문 뷰어에서 자막 가져오기', url, '', query, creator, 'review',
      '이미지 자막: 원문에서 이미지를 눌러 WinPNG·Jamaker 뷰어로 내려받아 주세요.'));
  }
  return files;
}

async function fromBlogger(context, source, aliases, query, creator) {
  const origin = source.origin;
  const found = [];
  const warnings = [];
  if (/^\/\d{4}\/\d{2}\/[^/]+\.html$/.test(source.pathname)) {
    try { found.push(...await readPost(context, source.href, aliases, query, creator, 'blogger')); }
    catch (error) { warnings.push(error.message); }
    if (query.episode != null && found.length) return { found, warnings };
  }
  for (const alias of aliases.slice(0, 2)) {
    let start = 1;
    let feedFailed = false;
    for (let page = 0; page < 3; page++) {
      const url = new URL('/feeds/posts/default', origin);
      url.searchParams.set('alt', 'json');
      url.searchParams.set('max-results', '100');
      url.searchParams.set('q', alias);
      if (start > 1) url.searchParams.set('start-index', String(start));
      try {
        const data = await context.get(url.href, 'json');
        const entries = data?.feed?.entry || [];
        if (!Array.isArray(entries)) throw new Error('Blogger 피드 형식 오류');
        for (const entry of entries) {
          const post = entry?.link?.find(link => link?.rel === 'alternate')?.href;
          const postUrl = safeUrl(post);
          if (!postUrl || postUrl.origin !== origin || !/^\/\d{4}\/\d{2}\/[^/]+\.html$/.test(postUrl.pathname)) continue;
          found.push(...await postAttachments(context, entry?.content?.$t || '', entry?.title?.$t || '', postUrl.href,
            aliases, query, creator, 'blogger'));
        }
        const total = Number(data?.feed?.['openSearch$totalResults']?.$t);
        if (!entries.length || entries.length < 100 || (Number.isFinite(total) && start + entries.length > total)) break;
        start += entries.length;
      } catch (error) { warnings.push(`Blogger 피드: ${error.message}`); feedFailed = true; break; }
    }
    if (feedFailed || !found.length) {
      // Public HTML search still works on blogs with a disabled JSON feed.
      try {
        const url = new URL('/search', origin);
        url.searchParams.set('q', alias);
        const doc = documentInfo(await context.get(url.href));
        const posts = doc.links.map(link => ({ link, url: safeUrl(link.href, origin) }))
          .filter(({ link, url: page }) => page?.origin === origin
            && /^\/\d{4}\/\d{2}\/[^/]+\.html$/.test(page.pathname)
            && matchTitle(link.text, aliases, query.season, query.episode) !== 'none')
          .slice(0, 8);
        for (const { url: page } of posts) {
          try { found.push(...await readPost(context, page.href, aliases, query, creator, 'blogger')); }
          catch (error) { warnings.push(`Blogger 글: ${error.message}`); }
          if (query.episode != null && found.length) break;
        }
      } catch (error) { warnings.push(`Blogger 검색: ${error.message}`); }
    }
    if (query.episode != null && found.length) break;
  }
  return { found, warnings: found.length ? [] : warnings };
}

async function fromNaver(context, source, aliases, query, creator) {
  const found = [];
  const warnings = [];
  const post = naverPostUrl(source.href);
  if (post) {
    try { found.push(...await readPost(context, post, aliases, query, creator, 'naver')); }
    catch (error) { warnings.push(error.message); }
    if (query.episode != null && found.length) return { found, warnings: [] };
  }
  const blog = naverBlogId(source);
  if (!blog) return { found, warnings };
  const visited = new Set(post ? [post] : []);
  let postsRead = 0;
  async function readListedPosts(items, base = source.href) {
    for (const item of items) {
      const safe = safeUrl(item.url, base);
      const url = safe && naverPostUrl(safe.href);
      if (!url || naverBlogId(new URL(url)) !== blog || visited.has(url)
        || matchTitle(plain(item.title), aliases, query.season, query.episode) === 'none') continue;
      if (postsRead >= 8 || context.remaining <= 0) break;
      visited.add(url);
      postsRead++;
      try { found.push(...await readPost(context, url, aliases, query, creator, 'naver')); }
      catch (error) { warnings.push(error.message); }
      if (query.episode != null && found.length) break;
    }
  }
  for (const alias of aliases.slice(0, 2)) {
    const search = new URL('https://blog.naver.com/PostSearchList.naver');
    search.searchParams.set('blogId', blog);
    search.searchParams.set('SearchText', alias);
    try {
      const doc = documentInfo(await context.get(search.href));
      await readListedPosts(doc.links.map(link => ({ url: link.href, title: link.text })), search.href);
    } catch (error) { warnings.push(`네이버 검색: ${error.message}`); }
    if (query.episode != null && found.length) break;
  }
  // The desktop search page may be empty or change shape. RSS and the mobile
  // JSON indexes are independent public paths, still restricted to this blog.
  if (!found.length && context.remaining > 0) {
    try {
      const xml = await context.get(`https://rss.blog.naver.com/${encodeURIComponent(blog)}.xml`);
      const xmlText = (item, tag) => decodeHtml(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(item)?.[1] || '')
        .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
      await readListedPosts([...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
        .slice(0, 100).map(item => ({ url: xmlText(item[1], 'link'), title: xmlText(item[1], 'title') })));
    } catch (error) { warnings.push(`네이버 RSS: ${error.message}`); }
  }
  if (!found.length && context.remaining > 0) {
    const api = `https://m.blog.naver.com/api/blogs/${encodeURIComponent(blog)}`;
    const streams = aliases.slice(0, 2).map(alias => `${api}/search/post?query=${encodeURIComponent(alias)}`);
    streams.push(`${api}/post-list?categoryNo=0&itemCount=30`);
    for (const stream of streams) {
      for (let page = 1; page <= 2 && context.remaining > 0; page++) {
        try {
          const data = await context.get(`${stream}&page=${page}`, 'json');
          const items = data?.result?.items ?? data?.result?.list;
          if (!Array.isArray(items)) throw new Error('글 목록 응답 형식 오류');
          await readListedPosts(items.slice(0, 100).map(item => ({
            title: item?.title || item?.titleWithInspectMessage || '',
            url: `https://blog.naver.com/${blog}/${String(item?.logNo ?? item?.logNoStr ?? '')}`,
          })));
          if (found.length || items.length < 20 || postsRead >= 8) break;
        } catch (error) { warnings.push(`네이버 모바일 목록: ${error.message}`); break; }
      }
      if (found.length || postsRead >= 8 || context.remaining <= 0) break;
    }
  }
  return { found, warnings: found.length ? [] : warnings };
}

async function fromTistory(context, source, aliases, query, creator) {
  const found = [];
  const warnings = [];
  const isPost = /^\/(?:\d+|entry\/[^/]+)\/?$/.test(source.pathname);
  if (isPost) {
    try { found.push(...await readPost(context, source.href, aliases, query, creator, 'tistory')); }
    catch (error) { warnings.push(error.message); }
    if (query.episode != null && found.length) return { found, warnings: [] };
  }
  for (const alias of aliases.slice(0, 2)) {
    const search = `${source.origin}/search/${encodeURIComponent(alias)}`;
    try {
      const doc = documentInfo(await context.get(search));
      const posts = [...new Set(doc.links.map(link => {
        const url = safeUrl(link.href, search);
        const title = link.at['data-tiara-copy'] || link.at['data-tiara-name'] || link.text;
        return url?.origin === source.origin && /^\/(?:\d+|entry\/[^/]+)\/?$/.test(url.pathname)
          && matchTitle(title, aliases, query.season, query.episode) !== 'none' ? url.href : null;
      }).filter(Boolean))].slice(0, 8);
      for (const post of posts) {
        if (post === source.href) continue;
        try { found.push(...await readPost(context, post, aliases, query, creator, 'tistory')); }
        catch (error) { warnings.push(error.message); }
        if (query.episode != null && found.length) break;
      }
    } catch (error) { warnings.push(`티스토리 검색: ${error.message}`); }
    if (query.episode != null && found.length) break;
  }
  return { found, warnings: found.length ? [] : warnings };
}

async function sourceSearch(context, sourceInput, aliases, query, creator) {
  const source = safeUrl(sourceInput);
  if (source && driveFolderId(source.href)) return folderCandidates(context, source.href, query.q, aliases, query, creator);
  const kind = source && blogKind(source);
  if (!kind) throw new Error('자동 검색을 지원하지 않는 제작자 주소');
  if (kind === 'blogger') return fromBlogger(context, source, aliases, query, creator);
  if (kind === 'naver') return fromNaver(context, source, aliases, query, creator);
  return fromTistory(context, source, aliases, query, creator);
}

function sourceFallback(website, creator, title, note) {
  const source = safeUrl(website);
  const kind = source && blogKind(source);
  if (!kind) return null;
  let searchUrl = '';
  if (kind === 'blogger') {
    const search = new URL('/search', source.origin);
    search.searchParams.set('q', title);
    searchUrl = search.href;
  } else if (kind === 'tistory') {
    searchUrl = new URL(`/search/${encodeURIComponent(title)}`, source.origin).href;
  } else {
    const blog = source.searchParams.get('blogId') || source.pathname.split('/').filter(Boolean)[0];
    if (/^[\w-]+$/.test(blog || '')) {
      const search = new URL('https://blog.naver.com/PostSearchList.naver');
      search.searchParams.set('blogId', blog);
      search.searchParams.set('SearchText', title);
      searchUrl = search.href;
    }
  }
  return { creator, source_url: source.href, search_url: searchUrl, note };
}

function creatorKey(name) {
  // Do not use partial or punctuation-stripped names: distinct creators can
  // share a prefix (or differ only in a punctuation mark).
  return typeof name === 'string' ? name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function blogIdentity(website) {
  const url = safeUrl(website);
  const kind = url && blogKind(url);
  if (!kind) return null;
  if (kind === 'naver') {
    const blog = naverBlogId(url);
    return blog ? `https://blog.naver.com/${blog}` : null;
  }
  return url.origin;
}

async function creatorSiteIndex(context) {
  if (context.creatorSites) return context.creatorSites;
  context.creatorSites = (async () => {
    const index = new Map();
    // A Worker request has a finite subrequest budget. Recent pages recover
    // migrated blogs without scanning the entire translator history.
    for (const [path, maxPages, approved] of [
      ['translator/apply/list', 4, true], ['anime/caption/recent', 3, false],
    ]) {
      for (let page = 0; page < maxPages && context.remaining > 12; page++) {
        try {
          const body = await context.get(`${ANISSIA}/${path}/${page}`, 'json');
          const data = body?.data;
          if ((body?.code !== undefined && body.code !== 'ok') || !Array.isArray(data?.content)) break;
          for (const item of data.content.slice(0, 100)) {
            if (approved && item?.result !== 'PASS') continue;
            const key = creatorKey(item?.name);
            const url = safeUrl(item?.website);
            if (!key || !url || !blogIdentity(url.href)) continue;
            const sites = index.get(key) || [];
            if (!sites.some(site => blogIdentity(site) === blogIdentity(url.href))) sites.push(url.href);
            index.set(key, sites.slice(0, 4));
          }
          if (data.last !== false || !data.content.length) break;
        } catch { break; } // Optional indexes must not hide usable registered links.
      }
    }
    return index;
  })();
  return context.creatorSites;
}

export async function searchAnissia(input, fetcher = fetch) {
  let query;
  try { query = sanitizeQuery(input || {}); }
  catch (error) { return result([], [error.message]); }
  const context = new RequestContext(fetcher, 42, query.refresh);
  const candidates = [];
  const warnings = [];
  const sources = [];
  let works = [];
  const requestedId = input?.animeNo ?? input?.anime_no;
  if (requestedId != null && requestedId !== '') {
    const id = Number(requestedId);
    if (!Number.isInteger(id) || id < 1 || id > 1_000_000_000) return result([], ['선택한 작품 번호가 올바르지 않음']);
    works = [{ animeNo: id, subject: query.q, originalSubject: '' }];
    try {
      const body = await context.get(`${ANISSIA}/anime/list/0?${new URLSearchParams({ q: query.q })}`, 'json');
      const selected = body?.data?.content?.find(item => item.animeNo === id && typeof item.subject === 'string');
      if (selected) works = [selected];
    } catch { /* An explicit ID still works when the optional title index is unavailable. */ }
  } else {
    try {
      const url = `${ANISSIA}/anime/list/0?${new URLSearchParams({ q: query.q })}`;
      const body = await context.get(url, 'json');
      if ((body?.code !== undefined && body.code !== 'ok') || !Array.isArray(body?.data?.content)) {
        throw new Error('애니시아 작품 검색 응답 오류');
      }
      const wanted = normalized(query.q);
      const matched = body.data.content.filter(item => Number.isInteger(item?.animeNo)
        && item.animeNo > 0 && typeof item.subject === 'string'
        && (!query.season || (seasonOf(item.subject) || 1) === query.season)
        && [item.subject, item.originalSubject].some(title => {
          const value = normalized(title);
          return value === wanted || (wanted.length >= 4 && value.length >= 4
            && (value.includes(wanted) || wanted.includes(value)));
        }));
      const exact = matched.filter(item => [item.subject, item.originalSubject]
        .some(title => normalized(title) === wanted));
      works = (exact.length ? exact : matched).slice(0, 2);
      if (matched.length > works.length) warnings.push('비슷한 작품이 더 있어. 작품 찾기에서 정확한 작품을 선택해 줘');
    } catch (error) { warnings.push(`애니시아 작품 검색: ${error.message}`); }
  }
  const searchedBlogs = new Set();
  async function searchCreator(creator, aliases, workQuery, recover = true) {
    const name = typeof creator.name === 'string' && creator.name.trim() ? creator.name.trim() : '제작자';
    const attemptWarnings = [];
    const attemptSources = [];
    let found = false;
    const tried = new Set();
    async function attempt(website) {
      if (tried.has(website) || context.remaining <= 0) return;
      tried.add(website);
      const identity = blogIdentity(website);
      if (identity) searchedBlogs.add(identity);
      try {
        const searched = await sourceSearch(context, website, aliases, workQuery, name);
        candidates.push(...searched.found.map(item => creator.directory
          ? { ...item, note: [item.note, `별도 자막 목록(${creator.updated})에서 찾은 제작자`].filter(Boolean).join(' · ') }
          : item));
        if (searched.found.length) { found = true; return; }
        attemptWarnings.push(...searched.warnings.map(warning => `${name}: ${warning}`));
        const fallback = sourceFallback(website, name, aliases[0],
          searched.warnings.join(' / ') || '지원하는 공개 자막 후보를 찾지 못했습니다. 원문을 확인해 주세요.');
        if (fallback) attemptSources.push(fallback);
      } catch (error) {
        attemptWarnings.push(`${name}: ${error.message}`);
        const fallback = sourceFallback(website, name, aliases[0], error.message);
        if (fallback) attemptSources.push(fallback);
      }
    }
    if (creator.website) await attempt(creator.website);
    else attemptWarnings.push(`${name}: 원문 주소 없음`);
    if (!found && recover && creatorKey(creator.name) && context.remaining > 12) {
      const index = await creatorSiteIndex(context);
      for (const website of index.get(creatorKey(creator.name)) || []) {
        // A second post on the same blog can be valuable when the original post
        // was deleted, but avoid repeating that blog's full search repeatedly.
        if (tried.has(website)) continue;
        await attempt(website);
        if (found || context.remaining <= 8) break;
      }
    }
    if (!found) { warnings.push(...attemptWarnings); sources.push(...attemptSources); }
  }
  for (const work of works) {
    const firstCandidate = candidates.length;
    let data;
    try {
      data = await context.get(`${ANISSIA}/anime/caption/animeNo/${work.animeNo}`, 'json');
      if ((data?.code !== undefined && data.code !== 'ok') || !Array.isArray(data?.data)) {
        throw new Error('애니시아 제작자 목록 응답 오류');
      }
    } catch (error) { warnings.push(`애니시아 ${work.subject}: ${error.message}`); data = { data: [] }; }
    const workQuery = { ...query, q: work.subject || query.q, season: query.season ?? seasonOf(work.subject) };
    const aliases = [...new Set([...postAliases(workQuery.q), work.originalSubject].filter(Boolean))];
    for (const creator of data.data.slice(0, 12)) {
      if (!creator || typeof creator !== 'object') continue;
      await searchCreator(creator, aliases, workQuery);
      if (context.remaining <= 0) break;
    }
    // Retry only verified alternate episode numbers, never an assumed 12/13-episode season.
    if (candidates.length === firstCandidate && query.episode != null && context.remaining > 8
      && (input.anilistId || work.originalSubject)) {
      try {
        const metadataFetch = async (...args) => {
          if (context.remaining-- <= 0 || Date.now() >= context.deadline) throw new Error('회차 정보 조회 제한에 도달함');
          return context.fetcher(...args);
        };
        const { value: info } = await cachedValue(`episodes:${input.anilistId || work.originalSubject}`, async () => {
          const id = input.anilistId || await resolveAniListId(work.originalSubject, metadataFetch);
          return id ? loadEpisodeRelations(id, metadataFetch, { refresh: query.refresh }) : null;
        }, { namespace: fetcher, refresh: query.refresh, ttl: 7 * 86400000 });
        for (const alternate of verifiedEpisodeAlternatives(query.episode, info).slice(0, 2)) {
          const sites = [...new Map([...data.data, ...sources.map(item => ({ name: item.creator, website: item.source_url }))]
            .filter(item => item?.website).map(item => [item.website, item])).values()].slice(0, 4);
          for (const creator of sites) {
            if (context.remaining <= 0) break;
            const searched = await sourceSearch(context, creator.website, aliases, { ...workQuery, episode: alternate.episode }, creator.name).catch(() => null);
            for (const item of searched?.found || []) {
              if (!item.download_url) continue;
              const range = item.episode_range || episodeRange(item.title) || episodeRange(item.file_name);
              if (range && (range[1] > alternate.limit || alternate.minimum && range[0] < alternate.minimum)) continue;
              candidates.push({ ...item, episode: query.episode, matched_episode: alternate.episode, confidence: 'review', require_episode: true,
                note: `${item.note || ''} · AniList 회차 대응 ${query.episode} → ${alternate.episode}화 (원문 확인 필요)` });
            }
          }
          if (candidates.length > firstCandidate) break;
        }
      } catch (error) { warnings.push(`시즌 회차 확인: ${error.message}`); }
    }
    if (data.data.length > 12) warnings.push('제작자 목록은 작품마다 처음 12명만 확인함');
    if (context.remaining <= 0) break;
  }
  if (!candidates.length && context.remaining > 0) {
    const names = [...new Set([query.q, ...works.flatMap(work => [work.subject, work.originalSubject])].filter(Boolean))];
    const aliases = [...new Set(names.flatMap(postAliases))];
    for (const creator of directoryCaptions(names, query.season)) {
      const identity = blogIdentity(creator.website);
      if (!identity || searchedBlogs.has(identity)) continue;
      await searchCreator(creator, aliases, query, false);
      if (context.remaining <= 0) break;
    }
  }
  if (context.stale) warnings.unshift('외부 사이트 갱신에 실패해 이전 게시글·목록을 사용했습니다.');
  return { ...result(candidates, warnings), sources };
}

export async function searchDirect(input, fetcher = fetch) {
  let query;
  try { query = sanitizeQuery(input || {}); }
  catch (error) { return result([], [error.message]); }
  const url = safeUrl(input?.url);
  if (!url) return result([], ['지원하는 HTTPS 링크를 입력해 줘']);
  if (['download.blog.naver.com', 'blogfiles.pstatic.net', 'blog.kakaocdn.net'].includes(url.hostname)) {
    const name = fileNameOf(url.href);
    return goodFile(name, query.episode)
      ? result([candidate('직접 첨부', query.q, name, url.href, url.href, query, '', 'review')])
      : result([], ['지원하는 자막 파일 링크가 아님']);
  }
  if (driveLink(url.href)) {
    return result([candidate('직접 Drive', query.q, 'Google Drive 파일', url.href, url.href, query, '', 'review',
      'Drive에서 실제 파일명을 확인해 줘')]);
  }
  if (driveFolderId(url.href)) {
    const context = new RequestContext(fetcher, 12, query.refresh);
    try {
      const listed = await folderCandidates(context, url.href, query.q, [query.q], query, '사용자 링크');
      return result(listed.found, [...listed.warnings, ...(context.stale ? ['폴더 갱신에 실패해 이전 목록을 사용했습니다.'] : [])]);
    } catch (error) { return result([], [error.message]); }
  }
  if (!blogKind(url)) return result([], ['지원하는 제작자 게시글 링크가 아님']);
  const context = new RequestContext(fetcher, 18, query.refresh);
  try {
    const searched = await sourceSearch(context, url.href, [query.q], query, '사용자 링크');
    return result(searched.found, [...searched.warnings, ...(context.stale ? ['게시글 갱신에 실패해 이전 목록을 사용했습니다.'] : [])]);
  } catch (error) { return result([], [error.message]); }
}
