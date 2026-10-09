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
