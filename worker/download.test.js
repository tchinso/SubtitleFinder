import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { downloadSubtitle, safeDownloadUrl, unzipFiles } from './download.js';

const FILE = 'https://blog.kakaocdn.net/subtitle.srt';
const SRT = '1\n00:00:01,000 --> 00:00:03,000\n책벌레의 하극상\n';
const params = values => new URLSearchParams({ url: FILE, name: '자막.srt', ...values });
const bytesOf = response => response.arrayBuffer().then(value => new Uint8Array(value));

function responseFetcher(body, headers = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(body, { headers });
  };
  fetcher.calls = calls;
  return fetcher;
}

function zipOffsets(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  return { view, end, central: view.getUint32(end + 16, true) };
}

test('download URL policy validates hosts, credentials, protocols and exact Drive identifiers', () => {
  for (const url of ['http://blog.kakaocdn.net/a.srt', 'https://127.0.0.1/a.srt',
    'https://blog.kakaocdn.net.attacker.example/a.srt', 'https://user:secret@blog.kakaocdn.net/a.srt',
    'https://blog.kakaocdn.net:8080/a.srt', 'https://jimaku.cc/api/entries', 'https://drive.google.com/folders/abcde']) {
    assert.equal(safeDownloadUrl(url), null, url);
  }
  const drive = safeDownloadUrl('https://drive.google.com/file/d/abcdef/view?resourcekey=shared_key');
  assert.equal(drive.origin, 'https://drive.usercontent.google.com');
  assert.equal(drive.searchParams.get('id'), 'abcdef');
  assert.equal(drive.searchParams.get('resourcekey'), 'shared_key');
  assert.ok(safeDownloadUrl('https://jimaku.cc/entry/12/download/subtitle.ass'));
});

test('unsafe initial links and redirects are rejected before contacting another host', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response('', { status: 302, headers: { Location: 'https://attacker.example/subtitle.srt' } });
  };
  await assert.rejects(downloadSubtitle(params({ url: 'https://127.0.0.1/private' }), fetcher), /파일 요청/);
  assert.equal(calls.length, 0);
  await assert.rejects(downloadSubtitle(params(), fetcher), /이동 주소/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('download validates dialogue content rather than trusting a subtitle extension', async () => {
  const fetcher = responseFetcher('<!doctype html><html><form>Sign in</form></html>', { 'Content-Type': 'application/octet-stream' });
  await assert.rejects(downloadSubtitle(params({ mode: 'inspect' }), fetcher), /대사|자막/);
  await assert.rejects(downloadSubtitle(params({ mode: 'original' }), fetcher), /대사|자막/);
  assert.equal(fetcher.calls.length, 1, 'inspection and download reuse the same downloaded bytes');
});

test('UTF-16 inspection, original bytes and UTF-8 copies remain separate', async () => {
  const original = new Uint8Array(Buffer.concat([Buffer.from([255, 254]), Buffer.from(SRT.replaceAll('\n', '\r\n'), 'utf16le')]));
  const fetcher = responseFetcher(original, { 'Content-Disposition': "attachment; filename*=UTF-8''%EC%9E%90%EB%A7%89.srt" });
  const inspect = await (await downloadSubtitle(params(), fetcher)).json();
  assert.equal(inspect.valid, true);
  assert.equal(inspect.cue_count, 1);
  assert.equal(inspect.encoding, 'utf-16le');
  assert.equal(inspect.filename, '자막.srt');
  assert.equal(inspect.text, undefined, 'metadata does not include the entire subtitle');
  const originalResponse = await downloadSubtitle(params({ mode: 'original' }), fetcher);
  assert.deepEqual(await bytesOf(originalResponse), original);
  assert.equal(originalResponse.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(originalResponse.headers.get('Content-Disposition'), /attachment/);
  const converted = await downloadSubtitle(params({ mode: 'utf8' }), fetcher);
  assert.equal(await converted.text(), SRT);
  assert.match(converted.headers.get('Content-Disposition'), /utf8/);
  assert.equal(fetcher.calls.length, 1);
  await downloadSubtitle(params({ mode: 'inspect', refresh: '1' }), fetcher);
  assert.equal(fetcher.calls.length, 2);
});

test('announced and streamed file sizes are both capped before parsing', async () => {
  const announced = responseFetcher('small', { 'Content-Length': String(6 * 1024 * 1024 + 1) });
  await assert.rejects(downloadSubtitle(params(), announced), /6 MiB/);
  const streamed = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1));
    controller.close();
  } }));
  await assert.rejects(downloadSubtitle(params(), streamed), /6 MiB/);
});

test('ZIP inspection lists subtitle and font entries while excluding unrelated and traversal paths', async () => {
  const font = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const archive = zipSync({
    '시즌/책벌레 01.srt': strToU8(SRT), 'fonts/Example.ttf': font,
    'readme.txt': strToU8('ignored'), '../escape.srt': strToU8(SRT), '__MACOSX/._subtitle.srt': strToU8(SRT),
  });
  const fetcher = responseFetcher(archive);
  const info = await (await downloadSubtitle(params({ name: 'bundle.zip' }), fetcher)).json();
  assert.equal(info.archive, 'zip');
  assert.deepEqual(info.entries.map(item => ({ name: item.name, font: item.font })), [
    { name: '시즌/책벌레 01.srt', font: false }, { name: 'fonts/Example.ttf', font: true },
  ]);
  const entry = await (await downloadSubtitle(params({ name: 'bundle.zip', entry: '0' }), fetcher)).json();
  assert.equal(entry.valid, true);
  assert.equal(entry.cue_count, 1);
  const fontResponse = await downloadSubtitle(params({ name: 'bundle.zip', entry: '1', mode: 'original' }), fetcher);
  assert.deepEqual(await bytesOf(fontResponse), font);
  assert.match(fontResponse.headers.get('Content-Disposition'), /Example.ttf/);
  const preserved = await downloadSubtitle(params({ name: 'bundle.zip', mode: 'original' }), fetcher);
  assert.deepEqual(await bytesOf(preserved), archive);
  await assert.rejects(downloadSubtitle(params({ entry: '99' }), fetcher), /ZIP 항목/);
});

test('renaming arbitrary bytes as a font is insufficient', async () => {
  const archive = zipSync({ 'spoof.ttf': strToU8('<html>not a font</html>') });
  await assert.rejects(downloadSubtitle(params({ entry: '0', mode: 'original' }), responseFetcher(archive)), /폰트/);
});

test('ZIP rejects excessive entry counts, per-file expansion and encrypted payloads', () => {
  const tooMany = zipSync(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`${i}.srt`, new Uint8Array()])));
  assert.throws(() => unzipFiles(tooMany), /항목 수/);
  const huge = zipSync({ 'sub.srt': strToU8(SRT) });
  const { view, central } = zipOffsets(huge);
  view.setUint32(central + 24, 6 * 1024 * 1024 + 1, true);
  assert.throws(() => unzipFiles(huge), /압축 해제 크기/);
  const encrypted = zipSync({ 'sub.srt': strToU8(SRT) });
  const encryptedInfo = zipOffsets(encrypted);
  encryptedInfo.view.setUint16(encryptedInfo.central + 8, 1, true);
  assert.throws(() => unzipFiles(encrypted), /암호화 ZIP/);
});

test('ZIP rejects disagreement between decoder and preflight directory counts', () => {
  const archive = zipSync({ 'sub.srt': strToU8(SRT) });
  const { view, end } = zipOffsets(archive);
  view.setUint16(end + 8, 2, true);
  assert.throws(() => unzipFiles(archive), /항목 수/);
});

test('ZIP64 locator cannot override preflight bounds', () => {
  const archive = zipSync({ 'sub.srt': strToU8(SRT) });
  const { view, end } = zipOffsets(archive);
  view.setUint32(end - 20, 0x07064b50, true);
  assert.throws(() => unzipFiles(archive), /ZIP64/);
});

test('ZIP rejects corrupt payloads even if the subtitle still has parseable dialogue', () => {
  const archive = zipSync({ 'sub.srt': strToU8(SRT) }, { level: 0 });
  const { view } = zipOffsets(archive);
  const offset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  archive[offset] = '2'.charCodeAt(0); // Still a valid SRT, but no longer its recorded CRC.
  assert.throws(() => unzipFiles(archive), /무결성/);
});

test('ZIP local payload bounds must not overlap the central directory', () => {
  const archive = zipSync({ 'sub.srt': strToU8(SRT) });
  const { view, central } = zipOffsets(archive);
  view.setUint32(central + 20, archive.length, true);
  assert.throws(() => unzipFiles(archive), /ZIP 항목 크기/);
});

test('7z originals are preserved and inspection explains extraction limitations', async () => {
  const archive = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  const fetcher = responseFetcher(archive);
  const info = await (await downloadSubtitle(params({ name: 'bundle.7z' }), fetcher)).json();
  assert.equal(info.archive, '7z');
  assert.equal(info.valid, false);
  assert.match(info.warnings[0], /원본 다운로드/);
  assert.deepEqual(await bytesOf(await downloadSubtitle(params({ name: 'bundle.7z', mode: 'original' }), fetcher)), archive);
  await assert.rejects(downloadSubtitle(params({ mode: 'utf8' }), fetcher), /7z·RAR/);
});

test('episode extraction fails closed when timestamps do not establish an episode bundle', async () => {
  await assert.rejects(downloadSubtitle(params({ mode: 'episode', first: '1', last: '2', episode: '1' }), responseFetcher(SRT)), /회차 구간/);
});

test('unknown Drive labels and incorrect extensions use the inspected subtitle format', async () => {
  for (const name of ['Google Drive 자막', 'wrong.zip']) {
    const res = await downloadSubtitle(params({ name, mode: 'original' }), responseFetcher(SRT));
    assert.match(res.headers.get('content-disposition'), /\.srt(?:"|;|$)/);
    assert.deepEqual(await bytesOf(res), new TextEncoder().encode(SRT));
  }
});
