const PAGE = "https://www.bigfile.co.kr/content/freecaption.php?cateGory=0005";
const SEARCH = "https://www.bigfile.co.kr/ajax/getContentList.php";
const FORMATS = /\.(?:srt|smi|sami|vtt|ass|ssa|zip|7z|rar)$/i;
const MAX_PAGES = 10;
const MAX_RESPONSE = 2_000_000;

async function boundedBytes(response) {
  if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE) {
    await response.body?.cancel();
    throw new Error("응답 크기 제한 초과");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new Error("응답 크기 제한 초과");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function checkResponse(response, endpoint) {
  // These APIs have fixed endpoints. Reject redirects, including same-host
  // login redirects, instead of following an upstream Location to arbitrary hosts.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.url && new URL(response.url).origin !== new URL(endpoint).origin) throw new Error("허용하지 않은 응답 주소");
}

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
  return { rows, lastPage: pages.reduce((last, page) => Number.isFinite(page) ? Math.max(last, page) : last, 1) };
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

function matchesTitle(filename, aliases) {
  const title = String(filename).normalize("NFKC").replace(FORMATS, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\bS\d{1,2}[ ._-]*E\d{1,3}\b|\b(?:season|시즌)\s*\d{1,2}|\d{1,2}\s*기/gi, " ")
    .replace(/\b(?:1080p|720p|2160p|480p|BDRip|BluRay|WEBRip|WEB-DL|x26[45]|h26[45]|AAC|FLAC|END|COMPLETE|SUBTITLES?|BD|TV)\b/gi, " ")
    .replace(/(?:^|[\s._-])(?:EP?|#)\s*\d{1,3}(?:v\d+)?(?:화|話|회)?(?=$|[\s._-])/gi, " ")
    .replace(/(?:[\s._-])\d{1,3}\s*[~～〜–-]\s*\d{1,3}(?:화|話|회)?[\s._-]*$/i, " ")
    .replace(/[\s._-]+\d{1,3}(?:v\d+)?(?:화|話|회)?[\s._-]*$/i, " ");
  return aliases.some(alias => normal(title) === normal(String(alias).replace(/\b(?:season|시즌)\s*\d{1,2}|\d{1,2}\s*기/gi, " ")));
}

function episodeRange(filename) {
  const stem = filename.replace(FORMATS, "");
  const match = /(?:^|[\s._[(])([0-9]{1,3})\s*[~～〜–-]\s*([0-9]{1,3})(?:화|話|회)?(?=$|[\s._\])])/i.exec(stem);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

async function searchTerm(query, term, fetcher) {
  const candidates = [];
  const warnings = [];
  const seen = new Set();
  const requestedSeason = query.season || seasonOf(query.q);
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, MAX_PAGES); page++) {
    try {
      const body = new URLSearchParams({ pagenum: String(page), cateGory: "0005", searchCaption: term });
      const response = await fetcher(SEARCH, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: PAGE },
        body,
        signal: AbortSignal.timeout(10000),
      });
      checkResponse(response, SEARCH);
      const buffer = await boundedBytes(response);
      const contentType = response.headers.get("Content-Type") || "";
      let html;
      if (/charset\s*=\s*["']?(?:euc-kr|ks_c_5601|cp949)/i.test(contentType)) html = new TextDecoder("euc-kr").decode(buffer);
      else {
        try { html = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
        catch { html = new TextDecoder("euc-kr").decode(buffer); }
      }
      const parsed = parseBigfileListing(html);
      if (page === 1) lastPage = parsed.lastPage;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        if (!matchesTitle(row.file_name, [query.q, term])) continue;
        const special = /(?:^|[^a-z])(?:OVA|OAD|SPECIAL|NCOP|NCED)(?=$|[^a-z])|특전|외전|특별편/i;
        if (special.test(row.file_name) && !special.test(query.q)) continue;
        const season = seasonOf(row.file_name);
        const range = episodeRange(row.file_name);
        const episode = range ? null : episodeOf(row.file_name);
        if (requestedSeason && season && season !== requestedSeason) continue;
        if (query.episode && episode && episode !== query.episode) continue;
        if (query.episode && range && (query.episode < range[0] || query.episode > range[1])) continue;
        candidates.push({
          provider: "Bigfile", title: query.q, file_name: row.file_name,
          source_url: PAGE, download_url: "", language: "ko", season, episode,
          confidence: query.episode && episode === query.episode && (!requestedSeason || season === requestedSeason)
            && !/\.(?:zip|7z|rar)$/i.test(row.file_name) ? "exact" : "review",
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
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: "query ($search: String!) { Page(perPage: 10) { media(search: $search, type: ANIME) { title { english romaji native } synonyms } } }",
      variables: { search: term },
    }),
    signal: AbortSignal.timeout(8000),
  });
  checkResponse(response, "https://graphql.anilist.co");
  const data = JSON.parse(new TextDecoder().decode(await boundedBytes(response)));
  const media = data?.data?.Page?.media;
  if (!Array.isArray(media)) return [];
  const exact = media.filter((entry) => {
    const values = [...Object.values(entry?.title || {}), ...(Array.isArray(entry?.synonyms) ? entry.synonyms : [])];
    return values.some((value) => typeof value === "string" && normal(value) === normal(term));
  });
  if (exact.length !== 1 || typeof exact[0]?.title?.romaji !== "string") return [];
  const romaji = exact[0].title.romaji.trim();
  return [...new Set([romaji, romaji.split(":", 1)[0].trim()])]
    .filter((value) => /[a-z]/i.test(value) && normal(value) !== normal(term));
}

export async function searchBigfile(query, fetcher = fetch) {
  const term = String(query.q || "").trim();
  if (!/[a-z]/i.test(term) || term.length > 120 || /[\u0000-\u001f]/.test(term)) return { candidates: [], warnings: ["빅파일 검색에는 120자 이하의 영문 작품명을 입력해 줘"], status: "error" };
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
