import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSubtitle, utf8Subtitle, extractBundleEpisode } from './subtitle-files.js';

const encode = value => new TextEncoder().encode(value);
const srt = '1\n00:00:01,000 --> 00:00:03,000\n안녕하세요\n';

test('validates dialogue content rather than trusting extension or HTTP success', () => {
  assert.equal(inspectSubtitle(encode(srt), { filename: 'test.srt' }).cue_count, 1);
  for (const body of ['<html><body>Access denied</body></html>', 'Not a subtitle', '1\n00:00:01,000 --> 00:00:03,000\n&nbsp;\n', '1\n00:00:09,000 --> 00:00:03,000\nwrong\n']) {
    assert.equal(inspectSubtitle(encode(body), { filename: 'test.srt' }).valid, false);
  }
  assert.equal(inspectSubtitle(encode('1\n00:99:01,000 --> 00:99:03,000\nwrong\n')).valid, false);
});

test('supports UTF16 in both byte orders and leaves original bytes unchanged', () => {
  for (const little of [true, false]) {
    const bytes = new Uint8Array((srt.length + 1) * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, little);
    for (let i = 0; i < srt.length; i++) view.setUint16((i + 1) * 2, srt.charCodeAt(i), little);
    const original = bytes.slice();
    const result = utf8Subtitle(bytes, { filename: 'test.srt' });
    assert.equal(result.valid, true);
    assert.equal(result.encoding, little ? 'utf-16le' : 'utf-16be');
    assert.equal(new TextDecoder().decode(result.bytes), srt);
    assert.deepEqual(bytes, original);
    assert.equal(inspectSubtitle(bytes.subarray(2)).encoding, little ? 'utf-16le' : 'utf-16be');
  }
});

test('uses language-specific Shift JIS and EUC KR legacy fallbacks', () => {
  const prefix = encode('1\n00:00:01,000 --> 00:00:03,000\n');
  const ja = new Uint8Array([...prefix, 0x82, 0xa0, 0x82, 0xa2]); // あい
  const ko = new Uint8Array([...prefix, 0xb0, 0xa1, 0xb3, 0xaa]); // 가나
  const japanese = inspectSubtitle(ja, { language: 'ja' });
  const korean = inspectSubtitle(ko, { language: 'ko' });
  assert.equal(japanese.valid, true);
  assert.equal(japanese.encoding, 'shift_jis');
  assert.match(japanese.text, /あい/);
  assert.equal(korean.encoding, 'euc-kr');
  assert.match(korean.text, /가나/);
});

test('ASS respects Events fields, reads fonts and excludes vector drawing-only events', () => {
  const header = '[Script Info]\nTitle: Test\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Noto Sans,24\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const drawing = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 100\n';
  const speech = 'Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\fnOther Font}Hello, world\\N안녕\n';
  assert.equal(inspectSubtitle(encode(header + drawing)).valid, false);
  const result = inspectSubtitle(encode(header + drawing + speech));
  assert.equal(result.cue_count, 1);
  assert.deepEqual(result.fonts, ['Noto Sans', 'Other Font']);
});

test('parses SAMI quoted timestamps and VTT settings without counting NOTE as dialogue', () => {
  assert.equal(inspectSubtitle(encode('<SAMI><BODY><SYNC Start=\'1000\'><P Class=KRCC>안녕<SYNC Start="2000"><P>&nbsp;</BODY></SAMI>')).cue_count, 1);
  const vtt = 'WEBVTT\n\nNOTE ignored\n00:00:01.000 --> 00:00:02.000\nnot a cue\n\n00:01.000 --> 00:02.000 align:start\nHello\n';
  assert.equal(inspectSubtitle(encode(vtt)).cue_count, 1);
});

function episodeSrt(label) {
  return Array.from({ length: 20 }, (_, index) => {
    const second = index * 30 + 1;
    const time = value => `00:${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')},000`;
    return `${index + 1}\n${time(second)} --> ${time(second + 2)}\n${label} ${index}\n`;
  }).join('\n');
}

test('bundle splitting requires explicit complete ranges and episode-sized ordered segments', () => {
  const bundle = episodeSrt('first') + '\n' + episodeSrt('second');
  const options = { format: 'srt', firstEpisode: 13, lastEpisode: 14, episode: 14 };
  const chosen = extractBundleEpisode(bundle, options);
  assert.match(chosen, /second 19/);
  assert.doesNotMatch(chosen, /first/);
  assert.equal(inspectSubtitle(encode(chosen)).cue_count, 20);
  assert.equal(extractBundleEpisode(bundle, { ...options, lastEpisode: 15 }), null);
  assert.equal(extractBundleEpisode(srt + '\n' + srt, { ...options }), null);
  assert.equal(extractBundleEpisode(bundle), null);
  assert.equal(extractBundleEpisode(bundle.replace('00:03:01,000', '00:02:01,000'), options), null);
});

test('rejects zero bytes, oversized data and malformed binary', () => {
  assert.equal(inspectSubtitle(new Uint8Array()).valid, false);
  assert.equal(inspectSubtitle(new Uint8Array(5 * 1024 * 1024 + 1)).valid, false);
  assert.equal(inspectSubtitle(new Uint8Array([0, 1, 2, 3])).valid, false);
});

test('ASS bundle copies retain drawings in the chosen episode', () => {
  const header = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const episode = label => Array.from({ length: 20 }, (_, i) => {
    const time = `0:${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '31' : '01'}.00`;
    const end = `0:${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '33' : '03'}.00`;
    return `Dialogue: 0,${time},${end},Default,,0,0,0,,${label} ${i}\nDialogue: 0,${time},${end},Default,,0,0,0,,{\\p1}m 0 0 l 1 1\n`;
  }).join('');
  const chosen = extractBundleEpisode(header + episode('first') + episode('second'), { format: 'ass', firstEpisode: 1, lastEpisode: 2, episode: 2 });
  assert.match(chosen, /second/);
  assert.doesNotMatch(chosen, /first/);
  assert.equal((chosen.match(/\\p1/g) || []).length, 20);
});
