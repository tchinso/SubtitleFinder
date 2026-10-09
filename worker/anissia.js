// Public Anissia creator posts. This module only requests known HTTPS hosts and
// returns verified source links; it never proxies an arbitrary URL or file.

const ANISSIA = 'https://api.anissia.net';
const SUBTITLE_EXT = /\.(?:srt|smi|sami|vtt|ass|ssa|zip|7z|rar)(?:$|[?#])/i;
const SPECIAL = /(?:^|[^a-z])(?:OVA|OAD|SP|SPECIAL|CHRISTMAS|NCOP|NCED)(?=$|[^a-z])|특전|외전|특별편/i;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function hostAllowed(host) {
  if (['api.anissia.net', 'blog.naver.com', 'm.blog.naver.com',
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
  if (!postTitle) return 'none';
  const title = postTitle.normalize('NFKC').replace(/^\s*\[(?:자막|Erai-raws|Ohys-Raws|SubsPlease|Moozzi2|Snow-Raws)\]\s*/i, '');
  if (!aliases.some(alias => SPECIAL.test(alias)) && SPECIAL.test(title.replace(/\bTV\s*\+\s*(?:OVA|OAD|SP)\b/ig, 'TV'))) return 'none';
  const statedSeason = seasonOf(title);
  if (season && statedSeason && season !== statedSeason) return 'none';
  const range = episodeRange(title);
  const statedEpisode = episodeOf(title);
  if (episode != null && ((range && (episode < range[0] || episode > range[1]))
    || (!range && statedEpisode !== episode))) return 'none';
  const prefix = title.split(/(?:\d{1,3}\s*(?:화|話|회)|\bS\d{1,2}[ ._-]*E\d{1,3}\b|자막)/i, 1)[0]
    .replace(/(?:\s+(?:BD|TV|블루레이|전체|통합|완결|한글|한국어))+\s*$/i, '').trim();
  const needle = normalized(prefix);
  const names = aliases.map(normalized).filter(name => name.length >= 2);
  if (!needle || !names.some(name => needle === name || (name.length >= 4 && needle.includes(name)))) return 'none';
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
  return { q, season, episode };
}

class RequestContext {
  constructor(fetcher, remaining = 42) {
    // Workers' global fetch must be called with its original binding.
    this.fetcher = (...args) => fetcher(...args);
    this.remaining = remaining;
  }

  async get(input, format = 'text') {
    let url = safeUrl(input);
    if (!url) throw new Error('지원하는 HTTPS 출처가 아님');
    for (let redirect = 0; redirect < 4; redirect++) {
      if (this.remaining-- <= 0) throw new Error('요청 횟수 제한에 도달함');
      const response = await this.fetcher(url.href, {
        method: 'GET', redirect: 'manual', headers: { Accept: format === 'json' ? 'application/json' : 'text/html,*/*' },
        signal: AbortSignal.timeout(12000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = safeUrl(response.headers.get('location'), url.href);
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

export async function discoverAnime(term, fetcher = fetch) {
  const q = String(term || '').trim();
  if (!q || q.length > 150 || /[\u0000-\u001f]/.test(q)) {
    return { anime: [], warnings: ['검색어를 입력해 줘'], status: 'error' };
  }
  const context = new RequestContext(fetcher, 22);
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
  const confidence = matchTitle(title, aliases, query.season, query.episode);
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
      if ((range && (query.episode < range[0] || query.episode > range[1]))
        || (!range && number != null && number !== query.episode)) continue;
    }
    const name = SUBTITLE_EXT.test(link.text) ? link.text : `${(link.text || 'Google Drive 자막').slice(0, 100)}.zip`;
    files.push(candidate('ReAnime/Blogger', title, name, postUrl, url, query, creator, 'review', 'Drive에서 실제 파일명을 확인해 줘'));
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
  return kind === 'blogger' ? bloggerAttachments(html, title, url, aliases, query, creator)
    : directAttachments(html, url, title, aliases, query, creator,
      kind === 'naver' ? 'ReAnime/네이버' : 'ReAnime/티스토리');
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
          found.push(...bloggerAttachments(entry?.content?.$t || '', entry?.title?.$t || '', postUrl.href,
            aliases, query, creator));
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
  const blog = source.searchParams.get('blogId') || source.pathname.split('/').filter(Boolean)[0];
  if (!/^[\w-]+$/.test(blog || '')) return { found, warnings };
  for (const alias of aliases.slice(0, 2)) {
    const search = new URL('https://blog.naver.com/PostSearchList.naver');
    search.searchParams.set('blogId', blog);
    search.searchParams.set('SearchText', alias);
    try {
      const doc = documentInfo(await context.get(search.href));
      const posts = unique(doc.links.map(link => ({ link, url: naverPostUrl(new URL(link.href, search).href) }))
        .filter(({ link, url }) => url?.includes(`/${blog}/`)
          && matchTitle(link.text, aliases, query.season, query.episode) !== 'none')
        .map(({ url }) => ({ source_url: url }))).slice(0, 8);
      for (const item of posts) {
        if (item.source_url === post) continue;
        try { found.push(...await readPost(context, item.source_url, aliases, query, creator, 'naver')); }
        catch (error) { warnings.push(error.message); }
        if (query.episode != null && found.length) break;
      }
    } catch (error) { warnings.push(`네이버 검색: ${error.message}`); }
    if (query.episode != null && found.length) break;
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
  const kind = source && blogKind(source);
  if (!kind) throw new Error('자동 검색을 지원하지 않는 제작자 주소');
  if (kind === 'blogger') return fromBlogger(context, source, aliases, query, creator);
  if (kind === 'naver') return fromNaver(context, source, aliases, query, creator);
  return fromTistory(context, source, aliases, query, creator);
}

export async function searchAnissia(input, fetcher = fetch) {
  let query;
  try { query = sanitizeQuery(input || {}); }
  catch (error) { return result([], [error.message]); }
  const context = new RequestContext(fetcher);
  const candidates = [];
  const warnings = [];
  let works = [];
  const requestedId = input?.animeNo ?? input?.anime_no;
  if (requestedId != null && requestedId !== '') {
    const id = Number(requestedId);
    if (!Number.isInteger(id) || id < 1 || id > 1_000_000_000) return result([], ['선택한 작품 번호가 올바르지 않음']);
    works = [{ animeNo: id, subject: query.q, originalSubject: '' }];
  } else {
    try {
      const url = `${ANISSIA}/anime/list/0?${new URLSearchParams({ q: query.q })}`;
      const body = await context.get(url, 'json');
      if ((body?.code !== undefined && body.code !== 'ok') || !Array.isArray(body?.data?.content)) {
        throw new Error('애니시아 작품 검색 응답 오류');
      }
      const wanted = normalized(query.q);
      const matched = body.data.content.filter(item => Number.isInteger(item?.animeNo)
        && item.animeNo > 0 && [item.subject, item.originalSubject].some(title => {
          const value = normalized(title);
          return value === wanted || (wanted.length >= 4 && value.length >= 4
            && (value.includes(wanted) || wanted.includes(value)));
        }));
      const exact = matched.filter(item => [item.subject, item.originalSubject]
        .some(title => normalized(title) === wanted));
      works = (exact.length ? exact : matched).slice(0, 2);
      if (matched.length > works.length) warnings.push('비슷한 작품이 더 있어. 작품 찾기에서 정확한 작품을 선택해 줘');
    } catch (error) { return result([], [`애니시아 작품 검색: ${error.message}`]); }
  }
  for (const work of works) {
    let data;
    try {
      data = await context.get(`${ANISSIA}/anime/caption/animeNo/${work.animeNo}`, 'json');
      if ((data?.code !== undefined && data.code !== 'ok') || !Array.isArray(data?.data)) {
        throw new Error('애니시아 제작자 목록 응답 오류');
      }
    } catch (error) { warnings.push(`애니시아 ${work.subject}: ${error.message}`); continue; }
    const workQuery = { ...query, q: work.subject || query.q, season: query.season ?? seasonOf(work.subject) };
    const aliases = [...new Set([...postAliases(workQuery.q), work.originalSubject].filter(Boolean))];
    for (const creator of data.data.slice(0, 12)) {
      if (!creator || typeof creator !== 'object') continue;
      const name = typeof creator.name === 'string' && creator.name.trim() ? creator.name.trim() : '제작자';
      if (!creator.website) { warnings.push(`${name}: 원문 주소 없음`); continue; }
      try {
        const searched = await sourceSearch(context, creator.website, aliases, workQuery, name);
        candidates.push(...searched.found);
        warnings.push(...searched.warnings.map(warning => `${name}: ${warning}`));
      } catch (error) { warnings.push(`${name}: ${error.message}`); }
      if (context.remaining <= 0) break;
    }
    if (data.data.length > 12) warnings.push('제작자 목록은 작품마다 처음 12명만 확인함');
    if (context.remaining <= 0) break;
  }
  return result(candidates, warnings);
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
  if (!blogKind(url)) return result([], ['지원하는 제작자 게시글 링크가 아님']);
  const context = new RequestContext(fetcher, 18);
  try {
    const searched = await sourceSearch(context, url.href, [query.q], query, '사용자 링크');
    return result(searched.found, searched.warnings);
  } catch (error) { return result([], [error.message]); }
}
