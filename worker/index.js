import { discoverAnime, searchAnissia, searchDirect } from "./anissia.js";
import { searchBigfile } from "./bigfile.js";
import { searchJimaku } from "./jimaku.js";

const SOURCE_NAMES = new Set(["anissia", "bigfile", "jimaku", "opensubtitles", "link"]);

function response(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function positiveNumber(value, label) {
  if (!value) return null;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1) throw new Error(`${label}은 양의 정수여야 해`);
  return Number(value);
}

export function openSubtitlesSearchUrl(q, language = "all") {
  const ids = { ko: "kor", en: "eng", all: "all" };
  const id = ids[language] || "all";
  const term = encodeURIComponent(q.trim()).replace(/%20/g, "+");
  return `https://www.opensubtitles.org/ko/search2/moviename-${term}/sublanguageid-${id}`;
}

function openSubtitlesResult(query, language) {
  const url = openSubtitlesSearchUrl(query.q, language);
  return {
    candidates: [{
      provider: "OpenSubtitles.org", title: query.q,
      file_name: "사이트에서 검색 결과 확인", source_url: url, download_url: "",
      language, season: query.season, episode: query.episode,
      confidence: "review", creator: "",
      note: "OpenSubtitles.org에서 직접 검색하고, 필요하면 브라우저에서 검증을 완료해 줘",
    }],
    warnings: [], status: "review",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET") return response({ status: "error", warnings: ["GET 요청만 지원해"], candidates: [] }, 405);
    if (url.pathname === "/api/health") return response({ status: "ok" });
    if (url.pathname !== "/api/anime" && url.pathname !== "/api/subtitles") {
      return response({ status: "error", warnings: ["알 수 없는 API 경로"], candidates: [] }, 404);
    }

    try {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || q.length > 120) throw new Error("작품명을 1~120자로 입력해 줘");
      if (url.pathname === "/api/anime") return response(await discoverAnime(q));

      const source = url.searchParams.get("source") || "";
      if (!SOURCE_NAMES.has(source)) throw new Error("지원하지 않는 검색 출처야");
      const query = {
        q,
        season: positiveNumber(url.searchParams.get("season"), "시즌"),
        episode: positiveNumber(url.searchParams.get("episode"), "화수"),
      };
      let result;
      if (source === "anissia") {
        const animeNo = positiveNumber(url.searchParams.get("animeNo"), "애니시아 작품 번호");
        result = await searchAnissia({ ...query, animeNo });
      } else if (source === "bigfile") {
        result = await searchBigfile(query);
      } else if (source === "jimaku") {
        result = await searchJimaku(query);
      } else if (source === "opensubtitles") {
        result = openSubtitlesResult(query, url.searchParams.get("language") || "all");
      } else {
        const sourceUrl = url.searchParams.get("url") || "";
        if (!sourceUrl || sourceUrl.length > 2048) throw new Error("원문 링크를 확인해 줘");
        result = await searchDirect({ ...query, url: sourceUrl });
      }
      return response(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "요청을 처리하지 못했어";
      return response({ status: "error", warnings: [message], candidates: [] }, 400);
    }
  },
};
