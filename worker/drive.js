const DRIVE = 'https://drive.google.com';
const ID = /^[\w-]{1,200}$/;
const SUBTITLE = /\.(?:ass|ssa|srt|smi|sami|vtt)$/i;
const ARCHIVE = /\.(?:zip|7z|rar)$/i;
const FONT = /\.(?:ttf|otf|ttc|woff2?)$/i;
const MAX_HTML = 2 * 1024 * 1024;

function googleUrl(value) {
  try {
    const url = new URL(value, DRIVE);
    return url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

export function driveFolderId(value) {
  const url = googleUrl(value);
  if (!url) return null;
  const id = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1]
    || (url.pathname === '/embeddedfolderview' ? url.searchParams.get('id') : null);
  return id && ID.test(id) ? id : null;
}

function decode(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()];
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
  });
}

function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3] ?? match[4])]));
}

export function parseDriveFolderHtml(html) {
  const entries = [];
  const starts = [...String(html).matchAll(/<[^>]+\bid\s*=\s*["']entry-([\w-]+)["'][^>]*>/gi)];
  starts.forEach((match, index) => {
    const id = match[1];
    if (!ID.test(id)) return;
    const chunk = html.slice(match.index + match[0].length, starts[index + 1]?.index ?? html.length);
    const anchor = /<a\b[^>]*>/i.exec(chunk);
    const url = googleUrl(anchor ? attrs(anchor[0]).href : '');
    if (!url) return;
    const folder = Boolean(driveFolderId(url.href));
    const linkedId = driveFolderId(url.href) || /^\/file\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1]
      || (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
    if (linkedId !== id) return;
    const title = /<([\w-]+)\b[^>]*\bclass\s*=\s*["'][^"']*\bflip-entry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i.exec(chunk);
    const name = decode((title?.[2] || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (name && name.length <= 1024) entries.push({ id, name, folder, url: url.href });
  });
  return [...new Map(entries.map(entry => [entry.id, entry])).values()].slice(0, 500);
}

async function readFolder(url, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let current = googleUrl(url);
    for (let redirects = 0; redirects < 4; redirects++) {
      if (!current) throw new Error('허용되지 않은 Drive 주소입니다.');
      const response = await fetcher(current.href, { redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html', Referer: `${DRIVE}/` } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        current = location ? googleUrl(new URL(location, current).href) : null;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw new Error(`Drive 폴더를 읽지 못했습니다 (${response.status}).`);
      if (response.url && !googleUrl(response.url)) throw new Error('Drive 공개 폴더가 아닌 페이지로 이동했습니다.');
      if (Number(response.headers.get('content-length')) > MAX_HTML) {
        await response.body?.cancel();
        throw new Error('Drive 폴더 목록이 크기 제한을 초과했습니다.');
      }
      if (!response.body) return [];
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > MAX_HTML) throw new Error('Drive 폴더 목록이 크기 제한을 초과했습니다.');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return parseDriveFolderHtml(new TextDecoder().decode(bytes));
    }
    throw new Error('Drive 폴더의 이동 횟수가 너무 많습니다.');
  } finally { clearTimeout(timeout); }
}

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function seasonOf(value) {
  const match = /(?:\bS(\d{1,2})E\d+|(?:season|시즌)\s*(\d{1,2})|(?:제\s*)?(\d{1,2})\s*기)/i.exec(value);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

function episodeOf(value) {
  const stem = value.replace(/\.[a-z\d]+$/i, '').replace(/\[[^\]]*(?:1080|720|2160|x26[45]|[A-F\d]{8})[^\]]*\]/gi, '').trim();
  const patterns = [/\bS\d{1,2}[._ -]*E(\d{1,3})\b/i, /(?:^|\D)(\d{1,3})\s*(?:화|話|회)/,
    /(?:^|[\s._[-])E(?:P)?\s*(\d{1,3})(?=$|[\s._\]-])/i, /(?:^|[\s._-])(\d{1,3})(?:v\d+)?$/i];
  for (const pattern of patterns) { const match = pattern.exec(stem); if (match) return Number(match[1]); }
  return null;
}

export function selectDriveFiles(entries, { episode = null, season = null } = {}) {
  const files = [], fonts = [];
  for (const entry of entries) {
    if (entry.folder) continue;
    const url = googleUrl(entry.url);
    if (!url || !ID.test(entry.id)) continue;
    const direct = new URL('/uc', DRIVE);
    direct.searchParams.set('export', 'download');
    direct.searchParams.set('id', entry.id);
    const resourcekey = url.searchParams.get('resourcekey');
    if (resourcekey && ID.test(resourcekey)) direct.searchParams.set('resourcekey', resourcekey);
    const item = { ...entry, download_url: direct.href };
    if (FONT.test(entry.name)) { fonts.push(item); continue; }
    if (!SUBTITLE.test(entry.name) && !ARCHIVE.test(entry.name)) continue;
    if (/(?:^|[^a-z])(?:ova|oad|ncop|nced|special)(?:[^a-z]|$)|특전|외전/i.test(entry.name)) continue;
    const fileSeason = seasonOf(entry.name);
    if (season != null && fileSeason != null && Number(season) !== fileSeason) continue;
    const range = /(?:^|\D)(\d{1,3})\s*[~～〜–-]\s*(\d{1,3})(?=\s*(?:화|話|회|완결|\.|\]|$))/i.exec(entry.name);
    const fileEpisode = range ? null : episodeOf(entry.name);
    if (episode != null && range && (Number(episode) < Number(range[1]) || Number(episode) > Number(range[2]))) continue;
    if (episode != null && fileEpisode != null && Number(episode) !== fileEpisode) continue;
    files.push({ ...item, episode: fileEpisode, confidence: episode != null && fileEpisode === Number(episode) && !ARCHIVE.test(entry.name) ? 'exact' : 'review',
      ...(range ? { episode_range: [Number(range[1]), Number(range[2])] } : {}) });
  }
  files.sort((a, b) => (a.confidence === 'exact' ? 0 : 1) - (b.confidence === 'exact' ? 0 : 1) || a.name.localeCompare(b.name));
  return { files, fonts: fonts.slice(0, 40) };
}

export async function listDriveFolder(input, options = {}, fetcher = fetch) {
  const id = driveFolderId(input);
  if (!id) throw new Error('공개 Google Drive 폴더 주소를 확인해 주세요.');
  const original = googleUrl(input);
  const names = [options.q, ...(options.aliases || [])].map(normalize).filter(name => name.length >= 2);
  const titleMatch = name => names.some(title => normalize(name) === title || (title.length >= 4 && normalize(name).includes(title)));
  const fileTitleMatch = name => {
    if (titleMatch(name)) return true;
    const stem = name.replace(/\.[a-z\d]+$/i, '').replace(/\[[^\]]*\]/g, '')
      .replace(/\bS\d+[._ -]*E\d+\b/gi, '')
      .replace(/[\s._-]+(?:EP?\s*)?\d+(?:\s*[~～〜–-]\s*\d+)?(?:v\d+)?(?:화|話|회)?[\s._-]*$/i, '');
    return names.includes(normalize(stem));
  };
  const maxListings = Math.max(1, Math.min(16, Number(options.maxListings) || 12));
  const queue = [{ id, url: original.href, depth: 0, matched: false }];
  const seen = new Set();
  const warnings = [];
  for (let count = 0; queue.length && count < maxListings; count++) {
    const item = queue.shift();
    if (seen.has(item.id)) { count--; continue; }
    seen.add(item.id);
    const request = new URL('/embeddedfolderview', DRIVE);
    request.searchParams.set('id', item.id);
    const resourcekey = googleUrl(item.url)?.searchParams.get('resourcekey');
    if (resourcekey && ID.test(resourcekey)) request.searchParams.set('resourcekey', resourcekey);
    let entries;
    try { entries = await readFolder(request.href, fetcher); }
    catch (error) { warnings.push(error.message); continue; }
    if (item.depth === 0 || item.matched) {
      const numericName = entry => {
        const stem = entry.name.replace(/\.[a-z\d]+$/i, '').replace(/\[[^\]]*\]/g, '')
          .replace(/\bS\d+E\d+\b|\bEP?\s*\d+\b|\d+\s*(?:화|話|회)/gi, '')
          .replace(/\b(?:v\d+|1080p|720p|2160p)\b/gi, '');
        return !/[\p{L}]/u.test(stem);
      };
      const titleVerified = entry => item.matched || fileTitleMatch(entry.name)
        || (options.trustedTitle === true && numericName(entry));
      const scopedEntries = entries.filter(entry => entry.folder || FONT.test(entry.name) || titleVerified(entry) || numericName(entry));
      const selected = selectDriveFiles(scopedEntries, options);
      selected.files = selected.files.map(file => ({ ...file, title_verified: titleVerified(file),
        confidence: titleVerified(file) ? file.confidence : 'review' }));
      if (selected.files.length) {
        // Makers commonly place ASS companion fonts in a sibling Fonts folder.
        // Read only explicitly named font folders inside the same matched work.
        if (selected.files.some(file => /\.(?:ass|ssa)$/i.test(file.name))) {
          const fontFolders = entries.filter(entry => entry.folder && /^(?:fonts?|폰트|글꼴)(?:\s|$|[._-])/i.test(entry.name)).slice(0, Math.min(2, maxListings - count - 1));
          for (const folder of fontFolders) {
            const fontUrl = new URL('/embeddedfolderview', DRIVE);
            fontUrl.searchParams.set('id', folder.id);
            const fontKey = googleUrl(folder.url)?.searchParams.get('resourcekey');
            if (fontKey && ID.test(fontKey)) fontUrl.searchParams.set('resourcekey', fontKey);
            try { selected.fonts.push(...selectDriveFiles(await readFolder(fontUrl.href, fetcher)).fonts); }
            catch (error) { warnings.push(error.message); }
          }
          selected.fonts = [...new Map(selected.fonts.map(font => [font.id, font])).values()].slice(0, 40);
        }
        return { ...selected, files: selected.files.map(file => ({ ...file, folder_url: item.url })), warnings };
      }
    }
    if (item.depth >= 4) continue;
    const folders = entries.filter(entry => entry.folder && !seen.has(entry.id)
      && !(options.season != null && seasonOf(entry.name) != null && Number(options.season) !== seasonOf(entry.name)));
    folders.sort((a, b) => Number(titleMatch(b.name)) - Number(titleMatch(a.name))
      || Number(/\d+/.exec(b.name)?.[0] || 0) - Number(/\d+/.exec(a.name)?.[0] || 0));
    const next = folders.slice(0, 40).map(entry => ({ ...entry, depth: item.depth + 1, matched: item.matched || titleMatch(entry.name) }));
    queue.unshift(...next.filter(entry => entry.matched));
    queue.push(...next.filter(entry => !entry.matched));
  }
  if (queue.length) warnings.push('Drive 폴더 탐색 제한에 도달했습니다. 원문에서 나머지 폴더를 확인해 주세요.');
  return { files: [], fonts: [], warnings };
}
