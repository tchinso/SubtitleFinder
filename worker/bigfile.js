const PAGE = "https://www.bigfile.co.kr/content/freecaption.php?cateGory=0005";
const SEARCH = "https://www.bigfile.co.kr/ajax/getContentList.php";
const FORMATS = /\.(?:srt|smi|sami|vtt|ass|ssa|zip|7z|rar)$/i;
const MAX_PAGES = 10;

function directSearchCandidate(query, term) {
  return {
    provider: "Bigfile", title: query.q, file_name: "Bigfile에서 직접 검색",
    source_url: PAGE, download_url: "", language: "ko", season: query.season || null,
    episode: query.episode || null, confidence: "review", creator: "",
    note: `사이트의 애니 분류에서 '${term}'을 검색해 줘`,
  };
}

function normal(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function decodeHTML(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()] || "";
    const hex = entity[1]?.toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function textOf(html) {
  return decodeHTML(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

export function parseBigfileListing(html) {
  const [listing = "", pagination = ""] = html.split("^^^^^^^", 2);
  if (!html.includes("^^^^^^^")) throw new Error("빅파일 검색 응답 형식을 읽지 못함");
  const rows = [];
  for (const row of listing.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => textOf(match[1]));
    if (cells.length < 3 || !cells[0].includes("애니")) continue;
    const onclick = row[1].match(/\bonclick\s*=\s*(["'])\s*downLoad\(\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]\s*\)\s*;?\s*\1/i);
    if (onclick && FORMATS.test(cells[1])) rows.push({ file_name: cells[1], id: `${onclick[2]}:${onclick[3]}` });
  }
  const pages = [...pagination.matchAll(/CallCommentList\([^)]*,\s*(\d+)\s*\)/g)]
    .map((match) => Number(match[1]));
  return { rows, lastPage: Math.max(1, ...pages) };
}

function seasonOf(value) {
  const match = String(value).normalize("NFKC").match(/\bS(\d{1,2})[ ._-]*E\d+|\b(?:season|시즌)\s*(\d{1,2})|(?:^|\s)(\d{1,2})\s*기/i);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

function episodeOf(value) {
  const stem = String(value).normalize("NFKC").replace(FORMATS, "");
  const match = stem.match(/\bS\d{1,2}[ ._-]*E(\d{1,3})\b|(?:^|[\s._[(#-])(?:EP?|#)\s*0*(\d{1,3})(?=[\s._\])#-]|$)|(?:^|[\s._-])0*(\d{1,3})(?:화|話|회)?$/i);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

async function searchTerm(query, term, fetcher) {
  const candidates = [];
  const warnings = [];
  const seen = new Set();
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, MAX_PAGES); page++) {
    try {
      const body = new URLSearchParams({ pagenum: String(page), cateGory: "0005", searchCaption: term });
      const response = await fetcher(SEARCH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: PAGE },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("Content-Length")) > 2_000_000) throw new Error("응답 크기 제한 초과");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 2_000_000) throw new Error("응답 크기 제한 초과");
      const charset = /charset\s*=\s*["']?utf-8/i.test(response.headers.get("Content-Type") || "") ? "utf-8" : "euc-kr";
      const html = new TextDecoder(charset).decode(buffer);
      const parsed = parseBigfileListing(html);
      if (page === 1) lastPage = parsed.lastPage;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const season = seasonOf(row.file_name);
        const episode = episodeOf(row.file_name);
        if (query.season && season && season !== query.season) continue;
        if (query.episode && episode && episode !== query.episode) continue;
        candidates.push({
          provider: "Bigfile", title: query.q, file_name: row.file_name,
          source_url: PAGE, download_url: "", language: "ko", season, episode,
          confidence: query.episode && episode === query.episode ? "exact" : "review",
          creator: "", note: `빅파일에서 '${term}' 검색 · 로그인 후 사이트에서 다운로드`,
        });
      }
      if (page > 1 && parsed.rows.length && !fresh) {
        warnings.push("빅파일 페이지가 반복되어 검색을 중단했어");
        break;
      }
    } catch (error) {
      warnings.push(`빅파일 ${page}페이지: ${error.message}`);
      return candidates.length
        ? { candidates, warnings, status: "found" }
        : { candidates: [directSearchCandidate(query, term)], warnings, status: "review" };
    }
  }
  if (lastPage > MAX_PAGES) warnings.push(`빅파일 결과가 많아 처음 ${MAX_PAGES}페이지만 확인했어`);
  return { candidates, warnings, status: candidates.length ? "found" : "empty" };
}

async function romajiAliases(term, fetcher) {
  const response = await fetcher("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: "query ($search: String!) { Page(perPage: 10) { media(search: $search, type: ANIME) { title { english romaji native } synonyms } } }",
      variables: { search: term },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
  const data = await response.json();
  const media = data?.data?.Page?.media;
  if (!Array.isArray(media)) return [];
  const exact = media.filter((entry) => {
    const values = [...Object.values(entry.title || {}), ...(entry.synonyms || [])];
    return values.some((value) => typeof value === "string" && normal(value) === normal(term));
  });
  if (exact.length !== 1 || typeof exact[0]?.title?.romaji !== "string") return [];
  const romaji = exact[0].title.romaji.trim();
  return [...new Set([romaji, romaji.split(":", 1)[0].trim()])]
    .filter((value) => /[a-z]/i.test(value) && normal(value) !== normal(term));
}

export async function searchBigfile(query, fetcher = fetch) {
  const term = String(query.q || "").trim();
  if (!/[a-z]/i.test(term)) return { candidates: [], warnings: ["빅파일 검색에는 영문 작품명을 입력해 줘"], status: "error" };
  const first = await searchTerm(query, term, fetcher);
  if (first.status !== "empty") return first;
  try {
    for (const alias of await romajiAliases(term, fetcher)) {
      const result = await searchTerm(query, alias, fetcher);
      if (result.status === "found") {
        result.warnings.unshift(`빅파일에 '${term}' 결과가 없어 '${alias}'로 검색했어`);
        return result;
      }
      if (result.status === "error") return result;
    }
  } catch (error) {
    first.warnings.push(`AniList 별칭 확인: ${error.message}`);
  }
  return first;
}
