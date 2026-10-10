import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function renderLinks(koreanTitle, englishTitle) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          value: "",
          href: "",
          addEventListener() {},
        });
      }
      return elements.get(id);
    },
  };
  document.getElementById("title-input").value = koreanTitle;
  document.getElementById("english-input").value = englishTitle;
  runInNewContext(script, { document, URLSearchParams });
  return (id) => document.getElementById(id).href;
}

test("search actions build the requested direct search URLs", () => {
  const href = renderLinks("책벌레", "Ascendance of a Bookworm");

  const bigfileTag = html.match(/<a\b[^>]*\bid="bigfile-link"[^>]*>/)?.[0];
  assert.ok(bigfileTag);
  assert.equal(bigfileTag.match(/\bhref="([^"]+)"/)?.[1],
    "https://www.bigfile.co.kr/content/freecaption.php?cateGory=0005");

  const pdpop = new URL(href("pdpop-link"));
  assert.equal(pdpop.origin + pdpop.pathname, "https://new.pdpop.com/list/ALL");
  assert.equal(pdpop.searchParams.get("searchKeyword"), "subject");
  assert.equal(pdpop.searchParams.get("searchWord"), "책벌레");

  assert.equal(href("opensubtitles-link"),
    "https://www.opensubtitles.org/ko/search2/moviename-Ascendance+of+a+Bookworm/sublanguageid-all");
  assert.equal(href("jimaku-link"),
    "https://jimaku.cc/opensearch/redirect?anime=true&query=Ascendance%20of%20a%20Bookworm");

  for (const [id, query] of [
    ["google-ko-link", "책벌레 자막 배포"],
    ["google-en-link", "Ascendance of a Bookworm subtitle download"],
  ]) {
    const google = new URL(href(id));
    assert.equal(google.origin + google.pathname, "https://www.google.com/search");
    assert.equal(google.searchParams.get("q"), query);
    assert.equal(google.searchParams.get("gl"), "US");
    assert.equal(google.searchParams.get("num"), "100");
    assert.equal(google.searchParams.get("newwindow"), "1");
  }
});
