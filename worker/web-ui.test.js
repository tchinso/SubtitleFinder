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

class TestElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.value = "";
    this.href = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.className = "";
    this.ownText = "";
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ""; this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }
  async emit(name, data = {}) {
    const event = { preventDefault() {}, ...data };
    await Promise.all((this.listeners.get(name) || []).map(callback => callback(event)));
  }
  click() { return this.emit("click"); }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    return all.filter(child => selector === "*" || selector.startsWith(".")
      ? selector === "*" || child.className.split(/\s+/).includes(selector.slice(1))
      : child.tagName === selector.toUpperCase());
  }
  focus() { this.focused = true; }
  scrollIntoView() {}
}

function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), entries };
}

function ui(fetcher) {
  const elements = new Map();
  const created = [];
  const localStorage = storage(), sessionStorage = storage();
  const cache = new Map();
  const document = {
    body: new TestElement("body"),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new TestElement());
      return elements.get(id);
    },
    createElement(tag) {
      const node = new TestElement(tag);
      created.push(node);
      return node;
    },
  };
  const calls = [];
  class TestURL extends URL {
    static createObjectURL() { return "blob:subtitle-test"; }
    static revokeObjectURL() {}
  }
  runInNewContext(script, {
    document, URL: TestURL, URLSearchParams, AbortController, localStorage, sessionStorage,
    fetch: async (path, options) => {
      calls.push({ path, options });
      return fetcher(new URL(path, "https://sub.h2h.workers.dev"), options);
    },
    setTimeout() {},
    caches: { open: async () => ({
      match: async key => cache.get(key)?.clone(),
      put: async (key, response) => cache.set(key, response.clone()),
      keys: async () => [...cache.keys()],
      delete: async key => cache.delete(key),
    }) },
  });
  const get = id => document.getElementById(id);
  const button = text => get("candidate-list").querySelectorAll("button").find(node => node.textContent === text);
  return { get, button, calls, localStorage, sessionStorage, created, document };
}

const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const candidate = (title, extra = {}) => ({
  provider: "Jimaku", title, file_name: `${title}.srt`, language: "ja", episode: 3,
  download_url: "https://jimaku.cc/entry/123/download/subtitle.srt", source_url: "https://jimaku.cc/entry/123",
  confidence: "exact", ...extra,
});
const found = candidates => Response.json({ candidates, status: "found", warnings: [] });

test("Jimaku interactions send season, episode and saved release preferences across episodes", async () => {
  const app = ui(async () => found([candidate("[Selected] Honzuki - 03")]));
  app.get("title-input").value = "책벌레의 하극상";
  app.get("english-input").value = "Honzuki no Gekokujou";
  app.get("season-input").value = "2";
  app.get("episode-input").value = "3";
  const key = "subfinder:release:honzuki no gekokujou";
  app.localStorage.setItem(key, "[Previous] Honzuki - 02.ass");
  await app.get("jimaku-button").click();
  await settle();
  const first = new URL(app.calls[0].path, "https://example.test");
  assert.equal(first.searchParams.get("source"), "jimaku");
  assert.equal(first.searchParams.get("q"), "Honzuki no Gekokujou");
  assert.equal(first.searchParams.get("season"), "2");
  assert.equal(first.searchParams.get("episode"), "3");
  assert.equal(first.searchParams.get("preferredFile"), "[Previous] Honzuki - 02.ass");
  const fileLink = app.get("candidate-list").querySelectorAll("a").find(node => node.textContent === "파일 열기 ↗");
  await fileLink.click();
  app.get("episode-input").value = "4";
  await app.get("jimaku-button").click();
  await settle();
  const second = new URL(app.calls[1].path, "https://example.test");
  assert.equal(second.searchParams.get("episode"), "4");
  assert.equal(second.searchParams.get("preferredFile"), "[Selected] Honzuki - 03.srt");
});

test("invalid episode fields stop the search before issuing a network request", async () => {
  const app = ui(async () => { throw new Error("unexpected request"); });
  app.get("title-input").value = "아가씨 돌보기";
  app.get("episode-input").value = "0";
  await app.get("title-button").click();
  assert.equal(app.calls.length, 0);
  assert.equal(app.get("notice").dataset.kind, "error");
  assert.match(app.get("notice").textContent, /회차는 1~999/);
});

test("fresh search bypasses browser results, adds refresh=1 and replaces the saved result", async () => {
  let generation = 0;
  const app = ui(async () => found([candidate(`응답 ${++generation}`)]));
  app.get("title-input").value = "아가씨 돌보기";
  await app.get("title-button").click(); await settle();
  await app.get("title-button").click(); await settle();
  assert.equal(app.calls.length, 1);
  assert.match(app.get("notice").textContent, /저장 결과/);
  app.get("refresh-input").checked = true;
  await app.get("title-button").click(); await settle();
  assert.equal(app.calls.length, 2);
  assert.equal(new URL(app.calls[1].path, "https://example.test").searchParams.get("refresh"), "1");
  assert.match(app.get("candidate-list").textContent, /응답 2/);
  app.get("refresh-input").checked = false;
  await app.get("title-button").click(); await settle();
  assert.equal(app.calls.length, 2);
  assert.match(app.get("candidate-list").textContent, /응답 2/);
});

test("a cancelled late success cannot replace newer search results or fill the session cache", async () => {
  let finishOld;
  const app = ui(url => url.searchParams.get("q") === "책벌레의 하극상"
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(found([candidate("아가씨 돌보기")])));
  app.get("title-input").value = "책벌레의 하극상";
  await app.get("title-button").click();
  await app.get("cancel-button").click();
  assert.equal(app.calls[0].options.signal.aborted, true);
  assert.equal(app.document.body.attributes.get("aria-busy"), "false");
  app.get("title-input").value = "아가씨 돌보기";
  await app.get("title-button").click(); await settle();
  const notice = app.get("notice").textContent;
  finishOld(found([candidate("책벌레의 하극상")])); await settle();
  assert.match(app.get("candidate-list").textContent, /아가씨 돌보기/);
  assert.doesNotMatch(app.get("candidate-list").textContent, /책벌레의 하극상/);
  assert.equal(app.get("notice").textContent, notice);
  assert.equal(app.sessionStorage.entries.size, 1);
});

test("a cancelled late HTTP failure cannot replace the newer successful search notice", async () => {
  let finishOld;
  const app = ui(url => url.searchParams.get("q") === "책벌레의 하극상"
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(found([candidate("아가씨 돌보기")])));
  app.get("title-input").value = "책벌레의 하극상";
  await app.get("title-button").click();
  await app.get("cancel-button").click();
  app.get("title-input").value = "아가씨 돌보기";
  await app.get("title-button").click(); await settle();
  const notice = app.get("notice").textContent;
  finishOld(Response.json({ warnings: ["취소한 이전 검색의 오류"] }, { status: 503 })); await settle();
  assert.equal(app.get("notice").textContent, notice);
  assert.equal(app.get("notice").dataset.kind, "success");
});

test("ZIP inspection lets the user inspect a subtitle, save UTF-8 and return to fonts", async () => {
  const item = candidate("책벌레의 하극상", { file_name: "자막.zip", download_url: "https://blog.kakaocdn.net/sub.zip" });
  const app = ui(async url => {
    if (url.pathname === "/api/subtitles") return found([item]);
    assert.equal(url.pathname, "/api/file");
    if (url.searchParams.get("mode") === "inspect") {
      return Response.json(url.searchParams.has("entry")
        ? { valid: true, format: "srt", encoding: "utf-16le", cue_count: 42, warnings: [] }
        : { archive: "zip", entries: [{ index: 0, name: "episode03.srt", font: false }, { index: 1, name: "font.ttf", font: true }], warnings: [] });
    }
    return new Response("downloaded bytes", { headers: { "Content-Disposition": "attachment; filename*=UTF-8''episode03.utf8.srt" } });
  });
  app.get("title-input").value = "책벌레의 하극상";
  await app.get("title-button").click(); await settle();
  await app.button("내용 확인 · 저장").click();
  assert.match(app.get("candidate-list").textContent, /episode03.srt/);
  assert.match(app.get("candidate-list").textContent, /font.ttf/);
  await app.button("내용 확인").click();
  assert.match(app.get("candidate-list").textContent, /UTF-16LE|utf-16le/);
  const inspection = new URL(app.calls.at(-1).path, "https://example.test");
  assert.equal(inspection.searchParams.get("entry"), "0");
  await app.button("UTF-8 사본 저장").click();
  const save = new URL(app.calls.at(-1).path, "https://example.test");
  assert.equal(save.searchParams.get("mode"), "utf8");
  assert.equal(save.searchParams.get("entry"), "0");
  assert.ok(app.created.some(node => node.download === "episode03.utf8.srt" && node.href === "blob:subtitle-test"));
  const savedCalls = app.calls.length;
  await app.button("UTF-8 사본 저장").click();
  assert.equal(app.calls.length, savedCalls, "second save uses the stored file");
  assert.match(app.get("notice").textContent, /브라우저에 저장된/);
  await app.button("ZIP 목록으로").click();
  await app.button("폰트 저장").click();
  const fontSave = new URL(app.calls.at(-1).path, "https://example.test");
  assert.equal(fontSave.searchParams.get("mode"), "original");
  assert.equal(fontSave.searchParams.get("entry"), "1");
});
