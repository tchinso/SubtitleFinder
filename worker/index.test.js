import test from "node:test";
import assert from "node:assert/strict";
import worker, { openSubtitlesSearchUrl } from "./index.js";

const cookie = "magic_cookie=nom_nom_nom";
const makeRequest = (url, cookieHeader = cookie) => new Request(url, {
  headers: cookieHeader === null ? {} : { Cookie: cookieHeader },
});

test("Worker serves a 401 page without the exact cookie on assets and APIs", async () => {
  let assetRequests = 0;
  const env = { ASSETS: { fetch() { assetRequests++; return new Response("asset"); } } };
  for (const path of ["/", "/app.js", "/api/health"]) {
    for (const cookieHeader of [null, "magic_cookie=wrong", "other=nom_nom_nom", "magic_cookie=nom_nom_nom_extra"]) {
      const response = await worker.fetch(makeRequest(`https://example.test${path}`, cookieHeader), env);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("content-type"), /text\/html/i);
      assert.match(await response.text(), /401/);
    }
  }
  assert.equal(assetRequests, 0);
});

test("Worker permits the exact cookie alongside other cookies for assets and APIs", async () => {
  const env = { ASSETS: { fetch() { return new Response("asset"); } } };
  const cookieHeader = `other=one; ${cookie}; another=two`;
  const asset = await worker.fetch(makeRequest("https://example.test/", cookieHeader), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "asset");
  const api = await worker.fetch(makeRequest("https://example.test/api/health", cookieHeader), env);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).status, "ok");
});

test("OpenSubtitles.org search always includes all languages", () => {
  assert.equal(openSubtitlesSearchUrl("Yosuga no Sora"),
    "https://www.opensubtitles.org/ko/search2/moviename-Yosuga+no+Sora/sublanguageid-all");
});

test("Worker returns OpenSubtitles link without upstream fetch or API key", async () => {
  const request = makeRequest("https://example.test/api/subtitles?source=opensubtitles&q=Yosuga+no+Sora&language=en");
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
    const response = await worker.fetch(makeRequest(`https://example.test/api/subtitles?${query}`), {});
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
    const first = await (await worker.fetch(makeRequest(url), {})).json();
    assert.equal(first.candidates.length, 1);
    failed = true;
    const refreshed = await (await worker.fetch(makeRequest(`${url}&refresh=1`), {})).json();
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
    const first = await (await worker.fetch(makeRequest(url), {})).json();
    assert.equal(first.status, "ok");
    failed = true;
    const refreshed = await (await worker.fetch(makeRequest(`${url}&refresh=1`), {})).json();
    assert.equal(refreshed.cache, "stale");
    assert.equal(refreshed.candidates[0].download_url, first.candidates[0].download_url);
    assert.match(refreshed.warnings.join(" "), /이전/);
  } finally { globalThis.fetch = originalFetch; }
});
