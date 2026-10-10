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
