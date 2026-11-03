import test from 'node:test';
import assert from 'node:assert/strict';
import { driveFolderId, listDriveFolder, parseDriveFolderHtml, selectDriveFiles } from './drive.js';

const entry = (id, name, folder = false) => `<div class="flip-entry" id="entry-${id}"><a href="https://drive.google.com/${folder ? 'drive/folders' : 'file/d'}/${id}"><div class="flip-entry-title">${name}</div></a></div>`;
const file = (id, name) => ({ id, name, folder: false, url: `https://drive.google.com/file/d/${id}/view` });

test('Drive URL IDs are accepted only on the exact HTTPS host', () => {
  assert.equal(driveFolderId('https://drive.google.com/drive/u/0/folders/folder-1'), 'folder-1');
  assert.equal(driveFolderId('https://drive.google.com/embeddedfolderview?id=abc'), 'abc');
  for (const url of ['https://drive.google.com.evil.test/drive/folders/abc', 'http://drive.google.com/drive/folders/abc', 'https://user@drive.google.com/drive/folders/abc', 'https://drive.google.com:444/drive/folders/abc']) assert.equal(driveFolderId(url), null);
});

test('parses public embedded entries, rejecting mismatched link IDs and unsafe hosts', () => {
  const html = entry('one', 'A &amp; B 01.ass') + entry('two', 'Fonts', true)
    + entry('bad', 'bad.srt').replace('/file/d/bad', '/file/d/other')
    + entry('evil', 'evil.srt').replace('drive.google.com/', 'drive.google.com.evil.test/');
  const entries = parseDriveFolderHtml(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'A & B 01.ass');
  assert.equal(entries[1].folder, true);
});

test('selects only matching episode/season, retaining uncertain bundles for review and companion fonts', () => {
  const selected = selectDriveFiles([
    file('one', '[SubsPlease] Anime - 01 [1080p].ass'), file('two', 'Anime - 02.ass'), file('s2', 'Anime S02E01.ass'),
    file('batch', 'Anime 01-12.zip'), file('wrong-batch', 'Anime 13-24.zip'), file('ova', 'Anime OVA 01.ass'),
    file('font', 'Noto Sans.ttf'), file('other', 'cover.png'),
  ], { episode: 1, season: 1 });
  assert.deepEqual(selected.files.map(row => row.id), ['one', 'batch']);
  assert.equal(selected.files[0].confidence, 'exact');
  assert.equal(selected.files[1].confidence, 'review');
  assert.equal(selected.fonts[0].name, 'Noto Sans.ttf');
});

test('folder traversal chooses title folders and does not surface unrelated branches', async () => {
  const requests = [];
  const pages = { root: entry('wrong', '다른 작품', true) + entry('wanted', '책벌레의 하극상', true),
    wanted: entry('episode1', '책벌레의 하극상 01.ass') + entry('font', 'font.ttf'), wrong: entry('wrong1', '다른 작품 01.ass') };
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', { q: '책벌레의 하극상', episode: 1 }, async url => {
    const id = new URL(url).searchParams.get('id');
    requests.push(id);
    return new Response(pages[id] || '');
  });
  assert.deepEqual(requests, ['root', 'wanted']);
  assert.equal(result.files[0].id, 'episode1');
  assert.equal(result.fonts.length, 1);
  assert.match(result.files[0].folder_url, /wanted$/);
});

test('preserves public resource keys and bounds cyclic folder traversal', async () => {
  const requests = [];
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root?resourcekey=key-1', { q: 'Anime', maxListings: 2 }, async url => {
    requests.push(new URL(url));
    return new Response(entry('root', 'root', true) + entry(`folder${requests.length}`, '2026', true));
  });
  assert.equal(requests[0].searchParams.get('resourcekey'), 'key-1');
  assert.equal(requests.length, 2);
  assert.equal(result.files.length, 0);
  assert.ok(result.warnings.length);
});

test('rejects redirects to private or login hosts without requesting them', async () => {
  const requests = [];
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', {}, async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secrets' } });
  });
  assert.equal(requests.length, 1);
  assert.equal(result.files.length, 0);
  assert.ok(result.warnings.length);
});

test('rejects oversized folders while reading the body', async () => {
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', {}, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.equal(result.files.length, 0);
  assert.match(result.warnings[0], /크기 제한/);
});

test('ASS files bring fonts from the explicit sibling font folder within listing limits', async () => {
  const calls = [];
  const pages = { root: entry('one', 'Anime 01.ass') + entry('fonts', 'Fonts', true), fonts: entry('font', 'Noto Sans.otf') };
  const fetcher = async url => { const id = new URL(url).searchParams.get('id'); calls.push(id); return new Response(pages[id]); };
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', { q: 'Anime', episode: 1 }, fetcher);
  assert.deepEqual(calls, ['root', 'fonts']);
  assert.equal(result.fonts[0].id, 'font');
  calls.length = 0;
  const limited = await listDriveFolder('https://drive.google.com/drive/folders/root', { q: 'Anime', episode: 1, maxListings: 1 }, fetcher);
  assert.deepEqual(calls, ['root']);
  assert.equal(limited.fonts.length, 0);
});

test('untrusted generic root rejects unrelated titles and leaves numeric-only names for review', async () => {
  const html = entry('wrong', 'Other Show 01.ass') + entry('numeric', '01.ass');
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', { q: 'Bookworm', episode: 1 }, async () => new Response(html));
  assert.deepEqual(result.files.map(file => file.id), ['numeric']);
  assert.equal(result.files[0].confidence, 'review');
  assert.equal(result.files[0].title_verified, false);
});

test('trusted post root accepts confirmed aliases and numeric files but rejects explicit unrelated titles', async () => {
  const result = await listDriveFolder('https://drive.google.com/drive/folders/root', { q: 'Bookworm', aliases: ['혼즈키'], episode: 1, trustedTitle: true }, async () => new Response(entry('one', '혼즈키 01.ass') + entry('two', 'Other Show 01.ass') + entry('numeric', '01.ass')));
  // Short aliases match the title portion exactly, not an arbitrary substring.
  assert.deepEqual(result.files.map(file => file.id).sort(), ['numeric', 'one']);
  assert.equal(result.files.find(file => file.id === 'one').confidence, 'exact');
});
