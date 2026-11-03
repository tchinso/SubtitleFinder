import { unzipSync } from 'fflate';
import { inspectSubtitle, extractBundleEpisode } from './subtitle-files.js';
import { cachedValue } from './cache.js';

const LIMIT = 6 * 1024 * 1024;
const SUBTITLE = /\.(?:srt|ass|ssa|smi|sami|vtt)$/i;
const FONT = /\.(?:ttf|otf|ttc|woff2?)$/i;
const fileNamespaces = new WeakMap();

export function safeDownloadUrl(input) {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    if (['blog.kakaocdn.net', 'download.blog.naver.com', 'blogfiles.pstatic.net'].includes(u.hostname)) return u;
    if (u.hostname === 'jimaku.cc' && /^\/entry\/\d+\/download\//.test(u.pathname)) return u;
    if (u.hostname === 'drive.google.com') {
      const id = /^\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] || (['/uc', '/open'].includes(u.pathname) ? u.searchParams.get('id') : null);
      if (!id || !/^[\w-]{5,200}$/.test(id)) return null;
      const out = new URL('https://drive.usercontent.google.com/download');
      out.searchParams.set('id', id);
      out.searchParams.set('export', 'download');
      if (u.searchParams.has('resourcekey')) out.searchParams.set('resourcekey', u.searchParams.get('resourcekey'));
      return out;
    }
    if (u.hostname === 'drive.usercontent.google.com' && u.pathname === '/download' && /^[\w-]{5,200}$/.test(u.searchParams.get('id') || '')) return u;
    return null;
  } catch { return null; }
}

function filename(value) {
  return String(value || 'subtitle').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'subtitle';
}

async function fetchFile(input, fetcher) {
  let url = safeDownloadUrl(input);
  if (!url) throw new Error('지원하는 공개 자막 파일 주소가 아닙니다.');
  for (let i = 0; i < 4; i++) {
    const res = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      url = location && safeDownloadUrl(new URL(location, url).href);
      await res.body?.cancel();
      if (!url) throw new Error('허용하지 않는 다운로드 이동 주소입니다.');
      continue;
    }
    if (!res.ok) throw new Error(`파일 서버 HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > LIMIT) { await res.body?.cancel(); throw new Error('파일 크기는 6 MiB까지 지원합니다.'); }
    const reader = res.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > LIMIT) { await reader.cancel(); throw new Error('파일 크기는 6 MiB까지 지원합니다.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const disposition = res.headers.get('content-disposition') || '';
    let name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] || /filename="([^"]+)"/i.exec(disposition)?.[1] || '';
    try { name = decodeURIComponent(name); } catch { /* Keep literal filename. */ }
    return { bytes, name };
  }
  throw new Error('다운로드 이동 횟수 제한을 초과했습니다.');
}

function archiveKind(bytes) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return 'zip';
  if ([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((b, i) => bytes[i] === b)) return '7z';
  if ([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07].every((b, i) => bytes[i] === b)) return 'rar';
  return '';
}

export function unzipFiles(bytes) {
  // Check every central-directory record before any decompression/allocation.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
  }
  if (end < 0) throw new Error('ZIP 디렉터리를 읽지 못했습니다.');
  const count = view.getUint16(end + 10, true);
  if (count > 256 || count !== view.getUint16(end + 8, true)
    || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    throw new Error('ZIP 항목 수, 분할 또는 ZIP64 형식을 지원하지 않습니다.');
  }
  const start = view.getUint32(end + 16, true);
  if (end + 22 + view.getUint16(end + 20, true) !== bytes.length
    || start + view.getUint32(end + 12, true) !== end) throw new Error('잘못된 ZIP 디렉터리입니다.');
  let p = start, total = 0;
  const entries = [];
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) throw new Error('잘못된 ZIP 디렉터리입니다.');
    const flags = view.getUint16(p + 8, true), size = view.getUint32(p + 24, true);
    const compression = view.getUint16(p + 10, true), compressed = view.getUint32(p + 20, true);
    const offset = view.getUint32(p + 42, true), crc = view.getUint32(p + 16, true);
    const nameSize = view.getUint16(p + 28, true), extraSize = view.getUint16(p + 30, true), commentSize = view.getUint16(p + 32, true);
    const next = p + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 1 || size > LIMIT || (total += size) > 32 * 1024 * 1024) throw new Error('암호화 ZIP 또는 압축 해제 크기 제한을 초과했습니다.');
    if (![0, 8].includes(compression) || view.getUint16(p + 34, true) !== 0
      || offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50
      || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== compression) {
      throw new Error('지원하지 않거나 손상된 ZIP 항목입니다.');
    }
    const localNameSize = view.getUint16(offset + 26, true), localExtraSize = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameSize + localExtraSize;
    if (localNameSize !== nameSize || dataStart + compressed > start || compression === 0 && compressed !== size
      || !(flags & 8) && (view.getUint32(offset + 18, true) !== compressed || view.getUint32(offset + 22, true) !== size)) {
      throw new Error('잘못된 ZIP 항목 크기입니다.');
    }
    const raw = bytes.subarray(p + 46, p + 46 + nameSize);
    if (!raw.every((byte, index) => byte === bytes[offset + 30 + index])) throw new Error('ZIP 파일 이름이 일치하지 않습니다.');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { name = new TextDecoder('euc-kr').decode(raw); }
    if (names.has(name)) throw new Error('중복된 ZIP 파일 이름입니다.');
    names.add(name);
    entries.push({ name, size, compressed, compression, crc });
    p = next;
  }
  if (p !== end) throw new Error('ZIP 디렉터리 길이가 일치하지 않습니다.');
  // fflate's filter order follows the same central directory; preserve decoded names separately.
  let index = 0;
  const mapped = new Map();
  const files = unzipSync(bytes, { filter: info => {
    const item = entries[index++];
    if (!item || info.originalSize !== item.size || info.size !== item.compressed || info.compression !== item.compression) {
      throw new Error('ZIP 항목 정보가 일치하지 않습니다.');
    }
    if (!SUBTITLE.test(item.name) && !FONT.test(item.name)) return false;
    if (/^(?:__MACOSX\/)|(?:^|\/)\./.test(item.name)) return false;
    mapped.set(info.name, item);
    return true;
  } });
  return Object.entries(files).map(([key, data]) => {
    const item = mapped.get(key);
    if (data.length !== item.size || crc32(data) !== item.crc) throw new Error('ZIP 파일의 무결성 검증에 실패했습니다.');
    return { name: item.name, bytes: data };
  });
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function fontValid(bytes) {
  const tag = new TextDecoder().decode(bytes.subarray(0, 4));
  return ['OTTO', 'ttcf', 'wOFF', 'wOF2', 'true'].includes(tag) || bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;
}

function attachment(bytes, name) {
  return new Response(bytes, { headers: {
    'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="subtitle${/\.[a-z0-9]+$/i.exec(name)?.[0] || '.txt'}"; filename*=UTF-8''${encodeURIComponent(filename(name)).replace(/'/g, '%27')}`,
    'Cache-Control': 'private, no-store',
  } });
}

export async function downloadSubtitle(params, fetcher = fetch) {
  const url = params.get('url') || '';
  const mode = params.get('mode') || 'inspect';
  if (!['inspect', 'original', 'utf8', 'episode'].includes(mode) || url.length > 4096 || !safeDownloadUrl(url)) throw new Error('파일 요청을 확인해 주세요.');
  if (!fileNamespaces.has(fetcher)) fileNamespaces.set(fetcher, {});
  const { value } = await cachedValue(`file:${url}`, () => fetchFile(url, fetcher), { namespace: fileNamespaces.get(fetcher), ttl: 300_000, staleTtl: 0, maxEntries: 4, refresh: params.get('refresh') === '1' });
  let bytes = value.bytes;
  let name = filename(value.name || params.get('name') || new URL(url).pathname.split('/').pop());
  const archive = archiveKind(bytes);
  const entry = params.get('entry');
  if (archive) {
    if (mode === 'original' && entry == null) return attachment(bytes, name.replace(/\.[^.]+$/, '') + '.' + archive);
    if (archive !== 'zip') {
      if (mode !== 'inspect') throw new Error('7z·RAR은 원본을 내려받아 압축을 풀어 주세요.');
      return Response.json({ valid: false, archive, entries: [], warnings: ['7z·RAR은 원본 다운로드 후 압축을 풀어 주세요.'] });
    }
    const files = unzipFiles(bytes);
    if (entry == null) return Response.json({ valid: false, archive, entries: files.map((item, index) => ({ index, name: item.name, font: FONT.test(item.name), size: item.bytes.length })), warnings: [] });
    if (!/^\d+$/.test(entry) || !files[Number(entry)]) throw new Error('ZIP 항목을 확인해 주세요.');
    ({ bytes, name } = files[Number(entry)]);
  } else if (entry != null) throw new Error('ZIP 파일이 아닙니다.');
  if (FONT.test(name)) {
    if (!fontValid(bytes)) throw new Error('유효한 폰트 파일이 아닙니다.');
    if (mode === 'original') return attachment(bytes, name);
    return Response.json({ valid: true, font: true, filename: name, size: bytes.length });
  }
  const info = inspectSubtitle(bytes, { filename: name, language: params.get('language') || '' });
  if (!info.valid) throw new Error(info.warnings?.join(' · ') || '대사가 있는 자막 파일을 확인하지 못했습니다.');
  const actualFormats = { ass: ['ass', 'ssa'], smi: ['smi', 'sami'], srt: ['srt'], vtt: ['vtt'] };
  if (!actualFormats[info.format]?.includes(name.split('.').pop().toLowerCase())) {
    name = name.replace(/\.(?:srt|ass|ssa|smi|sami|vtt|zip|7z|rar)$/i, '') + `.${info.format}`;
  }
  if (mode === 'inspect') return Response.json({ ...info, text: undefined, filename: name, size: bytes.length });
  if (mode === 'original') return attachment(bytes, name);
  let text = info.text;
  if (mode === 'episode') {
    text = extractBundleEpisode(text, { format: info.format, firstEpisode: Number(params.get('first')), lastEpisode: Number(params.get('last')), episode: Number(params.get('episode')) });
    if (!text) throw new Error('회차 구간을 확실히 구분할 수 없어 분리하지 않았습니다. 원본을 확인해 주세요.');
  }
  const suffix = mode === 'episode' ? `.E${params.get('episode')}.utf8` : '.utf8';
  const extension = /\.(srt|ass|ssa|smi|sami|vtt)$/i.exec(name)?.[0] || `.${info.format}`;
  return attachment(new TextEncoder().encode(text), name.replace(/\.[^.]+$/, '') + suffix + extension);
}
