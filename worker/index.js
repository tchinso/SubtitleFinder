import { discoverAnime, searchAnissia, searchDirect } from "./anissia.js";
import { searchBigfile } from "./bigfile.js";
import { searchJimaku } from "./jimaku.js";
import { cachedValue } from "./cache.js";
import { downloadSubtitle } from "./download.js";

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

function positiveNumber(value, label, max = 999999) {
  if (!value) return null;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${label}은 1~${max}의 정수여야 해`);
  return Number(value);
}

export function openSubtitlesSearchUrl(q) {
  const term = encodeURIComponent(q.trim()).replace(/%20/g, "+");
  return `https://www.opensubtitles.org/ko/search2/moviename-${term}/sublanguageid-all`;
}

function openSubtitlesResult(query) {
  const url = openSubtitlesSearchUrl(query.q);
  return {
    candidates: [{
      provider: "OpenSubtitles.org", title: query.q,
      file_name: "사이트에서 검색 결과 확인", source_url: url, download_url: "",
      language: "all", season: query.season, episode: query.episode,
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
    if (url.pathname === "/api/health") return response({ status: "ok", version: "2026-11-03-discovery" });
    if (!["/api/anime", "/api/subtitles", "/api/file"].includes(url.pathname)) {
      return response({ status: "error", warnings: ["알 수 없는 API 경로"], candidates: [] }, 404);
    }

    try {
      if (url.pathname === "/api/file") return await downloadSubtitle(url.searchParams);
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || q.length > 120 || /[\u0000-\u001f]/.test(q)) throw new Error("작품명을 1~120자로 입력해 줘");
      const refresh = url.searchParams.get("refresh") === "1";
      const withCache = async (key, loader) => {
        const { value, cache } = await cachedValue(key, loader, { refresh, namespace: fetch });
        return response({ ...value, cache, warnings: [...(value.warnings || []), ...(cache === "stale" ? ["외부 사이트 갱신에 실패해 이전 저장 결과를 표시합니다."] : [])] });
      };
      if (url.pathname === "/api/anime") return await withCache(`anime:${q}`, () => discoverAnime(q, fetch, { refresh }));

      const source = url.searchParams.get("source") || "";
      if (!SOURCE_NAMES.has(source)) throw new Error("지원하지 않는 검색 출처야");
      const query = {
        q,
        season: positiveNumber(url.searchParams.get("season"), "시즌", 99),
        episode: positiveNumber(url.searchParams.get("episode"), "화수", 999),
        refresh,
        anilistId: positiveNumber(url.searchParams.get("anilistId"), "AniList 작품 번호"),
      };
      let loader;
      if (source === "anissia") {
        const animeNo = positiveNumber(url.searchParams.get("animeNo"), "애니시아 작품 번호");
        loader = () => searchAnissia({ ...query, animeNo });
      } else if (source === "bigfile") {
        loader = () => searchBigfile(query);
      } else if (source === "jimaku") {
        const anilistId = query.anilistId;
        const preferredFile = (url.searchParams.get("preferredFile") || "").slice(0, 300);
        loader = async () => {
          const aliases = [];
          if (/[가-힣]/.test(q) && !anilistId) {
            const works = await discoverAnime(q, fetch, { refresh });
            const normal = value => value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
            const matches = works.anime.filter(item => normal(item.subject) === normal(q)
              || normal(item.subject.split(/\s*[~～〜]/)[0]) === normal(q));
            if (matches.length === 1 && matches[0].original_subject) aliases.push(matches[0].original_subject);
          }
          return searchJimaku({ ...query, anilistId, preferredFile, aliases });
        };
      } else if (source === "opensubtitles") {
        loader = () => openSubtitlesResult(query);
      } else {
        const sourceUrl = url.searchParams.get("url") || "";
        if (!sourceUrl || sourceUrl.length > 2048) throw new Error("원문 링크를 확인해 줘");
        loader = () => searchDirect({ ...query, url: sourceUrl });
      }
      const key = new URLSearchParams(url.searchParams);
      key.delete("refresh"); key.sort();
      return await withCache(`subtitles:${key}`, loader);
    } catch (error) {
      const message = error instanceof Error ? error.message : "요청을 처리하지 못했어";
      return response({ status: "error", warnings: [message], candidates: [] }, 400);
    }
  },
};
