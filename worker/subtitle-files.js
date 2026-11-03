// Byte decoding and content checks use only Web APIs so the same checks can run
// in a Worker and in the browser. The caller keeps the original byte array.
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] || raw;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
  });
}

function dialogueText(value) {
  return entities(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/\u00a0/g, ' ').trim();
}

function assText(value) {
  let drawing = false;
  let output = '';
  for (const part of value.split(/(\{[^}]*\})/g)) {
    if (part.startsWith('{')) {
      for (const mode of part.matchAll(/\\p(\d+)(?=\\|\}|\s|$)/g)) drawing = Number(mode[1]) > 0;
    } else if (!drawing) output += part;
  }
  return dialogueText(output.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
}

function seconds(value) {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || 0}`);
}

function validCue(start, end, text) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && /[\p{L}\p{N}]/u.test(text);
}

function parsedSubtitle(input) {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  const events = [];
  const fonts = new Set();
  let format = '';
  if (/^\s*\[(?:Script Info|Events)\]\s*$/im.test(text)) {
    format = 'ass';
    let section = '';
    let eventFields = null;
    let styleFields = null;
    let offset = 0;
    for (const line of text.split('\n')) {
      const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (sectionMatch) section = sectionMatch[1].toLowerCase();
      const fields = /^\s*Format\s*:\s*(.*)$/i.exec(line);
      if (fields) {
        const names = fields[1].split(',').map(name => name.trim().toLowerCase());
        if (section === 'events') eventFields = names;
        if (/styles$/.test(section)) styleFields = names;
      }
      const style = /^\s*Style\s*:\s*(.*)$/i.exec(line);
      if (style && styleFields) {
        const index = styleFields.indexOf('fontname');
        const name = index >= 0 ? style[1].split(',')[index]?.trim() : '';
        if (name) fonts.add(name);
      }
      const event = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
      if (event && section === 'events' && eventFields) {
        const parts = event[1].split(',');
        const textIndex = eventFields.indexOf('text');
        // ASS stores arbitrary commas in the last Text field only.
        if (textIndex === eventFields.length - 1 && textIndex >= 0 && parts.length >= eventFields.length) {
          const rawText = parts.slice(textIndex).join(',');
          const body = assText(rawText);
          const start = seconds(parts[eventFields.indexOf('start')] || '');
          const end = seconds(parts[eventFields.indexOf('end')] || '');
          for (const font of rawText.matchAll(/\\fn([^\\}]+)/g)) fonts.add(font[1].trim());
          if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
            const cue = { start, end, text: body, raw: line, offset, length: line.length };
            events.push(cue);
            if (validCue(start, end, body)) cues.push(cue);
          }
        }
      }
      offset += line.length + 1;
    }
  } else if (/<sami\b|<sync\b[^>]*\bstart\s*=/i.test(text)) {
    format = 'smi';
    const blocks = [...text.matchAll(/<sync\b[^>]*\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))[^>]*>([\s\S]*?)(?=<sync\b|<\/body\b|<\/sami\b|$)/gi)];
    blocks.forEach((block, index) => {
      const start = Number(block[1] || block[2] || block[3]) / 1000;
      const next = blocks[index + 1];
      const end = next ? Number(next[1] || next[2] || next[3]) / 1000 : start + 4;
      const body = dialogueText(block[4]);
      if (validCue(start, end, body)) cues.push({ start, end, text: body, raw: block[0], offset: block.index, length: block[0].length });
    });
  } else if (!/<(?:!doctype|html|script|form)\b/i.test(text.slice(0, 8192))) {
    format = /^WEBVTT(?:\s|$)/.test(text.trimStart()) ? 'vtt' : 'srt';
    for (const block of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g)) {
      const lines = block[0].split('\n');
      if (format === 'vtt' && /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const index = lines.findIndex(line => /^\s*\S+\s*-->\s*\S+/.test(line));
      if (index < 0 || index > 1) continue;
      const timing = /^\s*(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/.exec(lines[index]);
      const start = seconds(timing?.[1] || '');
      const end = seconds(timing?.[2] || '');
      const body = dialogueText(lines.slice(index + 1).join('\n').replace(/\{\\[^}]*\}/g, ''));
      if (validCue(start, end, body)) cues.push({ start, end, text: body, raw: block[0], offset: block.index, length: block[0].length });
    }
    if (!cues.length) format = '';
  }
  return { text, format, cues, events, fonts: [...fonts].filter(Boolean).slice(0, 64) };
}

export function decodeSubtitle(input, { language = 'ko' } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.byteLength || bytes.byteLength > MAX_SUBTITLE_BYTES) throw new Error('자막 파일이 비어 있거나 5 MB 제한을 초과했습니다.');
  let encodings = [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encodings = ['utf-16le'];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encodings = ['utf-16be'];
  else {
    // Detect BOM-less UTF-16 only when the ASCII structure leaves many NULs.
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    let even = 0, odd = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
    if (bytes.length % 2 === 0 && odd > sample.length / 5 && even < sample.length / 20) encodings.push('utf-16le');
    if (bytes.length % 2 === 0 && even > sample.length / 5 && odd < sample.length / 20) encodings.push('utf-16be');
    encodings.push('utf-8', ...(language === 'ja' ? ['shift_jis', 'euc-kr'] : ['euc-kr', 'shift_jis']));
  }
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
      if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) continue;
      return { text, encoding };
    } catch { /* Try only the explicitly supported legacy encodings. */ }
  }
  throw new Error('지원하는 자막 문자 인코딩으로 읽을 수 없습니다.');
}

export function inspectSubtitle(bytes, options = {}) {
  try {
    const decoded = decodeSubtitle(bytes, options);
    const parsed = parsedSubtitle(decoded.text);
    const warnings = [];
    if (!parsed.cues.length) warnings.push('유효한 시간 정보와 대사가 있는 자막을 찾지 못했습니다.');
    const extension = /\.([a-z]+)$/i.exec(options.filename || '')?.[1]?.toLowerCase();
    if (parsed.cues.length && extension && !({ ass: ['ass', 'ssa'], smi: ['smi', 'sami'], srt: ['srt'], vtt: ['vtt'] }[parsed.format] || []).includes(extension)) {
      warnings.push('파일 확장자와 실제 자막 형식이 다릅니다.');
    }
    if (!/^utf-/.test(decoded.encoding)) warnings.push(`${decoded.encoding} 인코딩으로 읽었습니다. 원본을 보존하고 UTF-8 사본을 만들 수 있습니다.`);
    return { valid: parsed.cues.length > 0, format: parsed.format, encoding: decoded.encoding,
      text: parsed.text, cue_count: parsed.cues.length, fonts: parsed.fonts, warnings };
  } catch (error) {
    return { valid: false, format: '', encoding: '', text: '', cue_count: 0, fonts: [], warnings: [error.message] };
  }
}

export function utf8Subtitle(bytes, options = {}) {
  const result = inspectSubtitle(bytes, options);
  if (!result.valid) throw new Error(result.warnings[0]);
  return { ...result, bytes: encoder.encode(result.text) };
}

// Splitting is opt-in, needs an explicit episode range, and requires complete
// episode-sized runs. Small out-of-order ASS events must never create episodes.
export function extractBundleEpisode(text, { format, firstEpisode, lastEpisode, episode } = {}) {
  if (![firstEpisode, lastEpisode, episode].every(Number.isInteger) || firstEpisode < 1
    || lastEpisode <= firstEpisode || lastEpisode - firstEpisode > 99 || episode < firstEpisode || episode > lastEpisode) return null;
  const parsed = parsedSubtitle(String(text));
  if (format && parsed.format !== format.toLowerCase().replace('ssa', 'ass')) return null;
  if (!['ass', 'srt', 'vtt'].includes(parsed.format)) return null;
  const segments = [[]];
  let previous = null;
  for (const cue of parsed.format === 'ass' ? parsed.events : parsed.cues) {
    if (previous && cue.start < previous.start - 5) {
      if (cue.start > 180 || previous.start < 480 || previous.start - cue.start < 480) return null;
      segments.push([]);
    }
    segments.at(-1).push(cue);
    previous = cue;
  }
  if (segments.length !== lastEpisode - firstEpisode + 1 || segments.some(segment => segment.filter(cue => /[\p{L}\p{N}]/u.test(cue.text)).length < 20
    || segment[0].start > 180 || segment.reduce((end, cue) => Math.max(end, cue.end), 0) - segment[0].start < 480)) return null;
  const chosen = segments[episode - firstEpisode];
  if (parsed.format === 'ass') {
    // Keep styles/attachments, remove all unselected events, including comments
    // that could carry episode-specific information from another segment.
    const offsets = new Set(chosen.map(cue => cue.offset));
    let offset = 0;
    return parsed.text.split('\n').filter(line => {
      const keep = !/^\s*(?:Dialogue|Comment)\s*:/i.test(line) || offsets.has(offset);
      offset += line.length + 1;
      return keep;
    }).join('\n');
  }
  const blocks = chosen.map((cue, index) => {
    const lines = cue.raw.trim().split('\n');
    if (!lines[0].includes('-->')) lines.shift();
    return `${parsed.format === 'srt' ? `${index + 1}\n` : ''}${lines.join('\n')}`;
  });
  const header = parsed.format === 'vtt' ? `${parsed.text.slice(0, parsed.cues[0].offset).trim()}\n\n` : '';
  return header + blocks.join('\n\n') + '\n';
}
