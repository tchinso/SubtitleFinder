import test from "node:test";
import assert from "node:assert/strict";
import worker, { openSubtitlesSearchUrl } from "./index.js";

test("OpenSubtitles.org search always includes all languages", () => {
  assert.equal(openSubtitlesSearchUrl("Yosuga no Sora"),
    "https://www.opensubtitles.org/ko/search2/moviename-Yosuga+no+Sora/sublanguageid-all");
});

test("Worker returns OpenSubtitles link without upstream fetch or API key", async () => {
  const request = new Request("https://example.test/api/subtitles?source=opensubtitles&q=Yosuga+no+Sora&language=en");
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "review");
  assert.match(result.candidates[0].source_url, /sublanguageid-all$/);
  assert.equal(result.candidates[0].language, "all");
  assert.equal(result.candidates[0].download_url, "");
});

test("Worker rejects unknown source and invalid title", async () => {
  for (const query of ["source=unknown&q=Example", "source=bigfile&q="]) {
    const response = await worker.fetch(new Request(`https://example.test/api/subtitles?${query}`), {});
    assert.equal(response.status, 400);
  }
});

test("a failed nested page refresh warns when the previous public post is reused", async () => {
  const originalFetch = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async () => {
    if (failed) throw new Error("offline");
    return new Response('<title>Example 1화</title><a href="https://drive.google.com/file/d/public123/view">Example E01.ass</a>');
  };
  try {
    const url = `https://example.test/api/subtitles?${new URLSearchParams({ source: "link", q: "Example", episode: "1", url: "https://creator.blogspot.com/2026/07/1.html" })}`;
    const first = await (await worker.fetch(new Request(url), {})).json();
    assert.equal(first.candidates.length, 1);
    failed = true;
    const refreshed = await (await worker.fetch(new Request(`${url}&refresh=1`), {})).json();
    assert.equal(refreshed.candidates[0].download_url, first.candidates[0].download_url);
    assert.match(refreshed.warnings.join(" "), /이전/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Jimaku upstream failure preserves successful cached files instead of caching a fallback link", async () => {
  const originalFetch = globalThis.fetch;
  const row = (extra, href) => `<div class="entry" data-extra="${JSON.stringify(extra).replace(/"/g, "&#34;")}"><a href="${href}">x</a></div>`;
  let failed = false;
  globalThis.fetch = async url => {
    if (failed) throw new Error("offline");
    return new Response(url === "https://jimaku.cc/" ? row({ anilist_id: 1, name: "Example" }, "/entry/10") : row({ name: "Example E01.srt", url: "/entry/10/download/E01.srt" }, ""));
  };
  try {
    const url = "https://example.test/api/subtitles?source=jimaku&q=Example&episode=1";
    const first = await (await worker.fetch(new Request(url), {})).json();
    assert.equal(first.status, "ok");
    failed = true;
    const refreshed = await (await worker.fetch(new Request(`${url}&refresh=1`), {})).json();
    assert.equal(refreshed.cache, "stale");
    assert.equal(refreshed.candidates[0].download_url, first.candidates[0].download_url);
    assert.match(refreshed.warnings.join(" "), /이전/);
  } finally { globalThis.fetch = originalFetch; }
});
