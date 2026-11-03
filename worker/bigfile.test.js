import test from "node:test";
import assert from "node:assert/strict";
import { parseBigfileListing, searchBigfile } from "./bigfile.js";

function listing(rows, last = 1) {
  return `<table>${rows.map(([name, content, caption, category = "애니"]) =>
    `<tr><td>[${category}]</td><td>&nbsp;${name}</td><td><a onclick="downLoad('${content}','${caption}')">다운로드</a></td></tr>`
  ).join("")}</table>^^^^^^^<a href="javascript:CallCommentList('x',${last});">마지막</a>`;
}

test("Bigfile parser keeps anime subtitle rows and pagination", () => {
  const result = parseBigfileListing(listing([
    ["Example S01E22.srt", "1", "2"],
    ["Example.exe", "3", "4"],
    ["Movie.srt", "5", "6", "영화"],
  ], 2));
  assert.deepEqual(result.rows, [{ file_name: "Example S01E22.srt", id: "1:2" }]);
  assert.equal(result.lastPage, 2);
});

test("Bigfile search reaches a later episode and keeps manual download", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    assert.equal(url, "https://www.bigfile.co.kr/ajax/getContentList.php");
    const page = Number(options.body.get("pagenum"));
    calls.push(page);
    return new Response(page === 1
      ? listing([["Example S01E23.srt", "1", "2"]], 2)
      : listing([["Example S01E22.smi", "3", "4"]], 2));
  };
  const result = await searchBigfile({ q: "Example", season: 1, episode: 22 }, fetcher);
  assert.equal(result.status, "found");
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(result.candidates.map(({ file_name }) => file_name), ["Example S01E22.smi"]);
  assert.equal(result.candidates[0].confidence, "exact");
  assert.equal(result.candidates[0].download_url, "");
});

test("Bigfile rejects non-Latin query before request", async () => {
  const result = await searchBigfile({ q: "강철의 연금술사" }, () => { throw new Error("unexpected fetch"); });
  assert.equal(result.status, "error");
  assert.deepEqual(result.candidates, []);
});

test("Bigfile checks work identity instead of trusting upstream search rows", async () => {
  const result = await searchBigfile({ q: "Example", episode: 1 }, async () => new Response(listing([
    ["Another Show 01.ass", "1", "1"], ["Example Junior 01.ass", "2", "2"],
    ["[SubsPlease] Example - 01 [1080p].ass", "3", "3"], ["Example OVA 01.ass", "4", "4"],
  ])));
  assert.equal(result.status, "found");
  assert.deepEqual(result.candidates.map(item => item.file_name), ["[SubsPlease] Example - 01 [1080p].ass"]);
});

test("Bigfile filters ranges and explicit seasons and keeps archives for review", async () => {
  const result = await searchBigfile({ q: "Example Season 2", episode: 1 }, async () => new Response(listing([
    ["Example S01E01.ass", "1", "1"], ["Example S02E01.ass", "2", "2"],
    ["Example 01-12.zip", "3", "3"], ["Example 13-24.zip", "4", "4"],
  ])));
  assert.deepEqual(result.candidates.map(item => item.file_name), ["Example S02E01.ass", "Example 01-12.zip"]);
  assert.equal(result.candidates[0].confidence, "exact");
  assert.equal(result.candidates[1].confidence, "review");
});

test("Bigfile and AniList refuse to follow redirects", async () => {
  for (const redirectSource of ["bigfile", "anilist"]) {
    const calls = [];
    const result = await searchBigfile({ q: "Example" }, async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "manual");
      if (redirectSource === "anilist" && url.includes("bigfile")) return new Response(listing([]));
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
    });
    assert.equal(calls.length, redirectSource === "bigfile" ? 1 : 2);
    assert.ok(result.warnings.some(warning => warning.includes("302")));
  }
});

test("listing and AniList response bodies are bounded even without content-length", async () => {
  for (const largeSource of ["bigfile", "anilist"]) {
    let cancelled = false;
    const result = await searchBigfile({ q: "Example" }, async url => {
      if (largeSource === "anilist" && url.includes("bigfile")) return new Response(listing([]));
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1_100_000)); },
        cancel() { cancelled = true; },
      }));
    });
    assert.equal(cancelled, true);
    assert.ok(result.warnings.some(warning => warning.includes("크기 제한")));
  }
});

test("exact AniList alias supplies title identity for a second Bigfile search", async () => {
  const result = await searchBigfile({ q: "Ascendance of a Bookworm", episode: 1 }, async (url, options) => {
    if (url.includes("anilist")) return Response.json({ data: { Page: { media: [{ title: { english: "Ascendance of a Bookworm", romaji: "Honzuki no Gekokujou" }, synonyms: [] }] } } });
    return new Response(listing(options.body.get("searchCaption") === "Honzuki no Gekokujou" ? [["Honzuki no Gekokujou - 01.ass", "1", "1"]] : []));
  });
  assert.equal(result.status, "found");
  assert.equal(result.candidates[0].file_name, "Honzuki no Gekokujou - 01.ass");
});
