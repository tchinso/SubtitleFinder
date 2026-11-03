(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const titleInput = $("title-input");
  const englishInput = $("english-input");
  const linkInput = $("link-input");
  const notice = $("notice");
  const animeSection = $("anime-section");
  const animeList = $("anime-list");
  const candidateSection = $("candidate-section");
  const candidateList = $("candidate-list");
  const searchButtons = [$("discover-button"), $("title-button"), $("link-button"), $("jimaku-button")];
  let activeRequest = null;

  function clean(value) {
    return String(value ?? "").trim();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeUrl(value) {
    try {
      const url = new URL(clean(value));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function showNotice(message, kind = "info") {
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = false;
  }

  function setLoading(loading) {
    for (const button of searchButtons) button.disabled = loading;
    for (const button of animeList.querySelectorAll("button")) button.disabled = loading;
    $("cancel-button").hidden = !loading;
    document.body.setAttribute("aria-busy", String(loading));
  }

  function requireTitle() {
    const title = clean(titleInput.value);
    if (title) return title;
    showNotice("먼저 애니 제목을 입력해 주세요.", "error");
    titleInput.focus();
    return "";
  }

  function requireEnglishTitle() {
    const title = clean(englishInput.value);
    if (title) return title;
    showNotice("Jimaku와 Google(영어) 검색에는 영문 또는 로마자 제목을 입력해 주세요.", "error");
    englishInput.focus();
    return "";
  }

  function requireAnyTitle() {
    const title = clean(englishInput.value) || clean(titleInput.value);
    if (title) return title;
    showNotice("애니 제목 또는 영문 · 로마자 제목을 입력해 주세요.", "error");
    titleInput.focus();
    return "";
  }

  function warningsText(data) {
    const warnings = Array.isArray(data?.warnings) ? data.warnings.map(clean).filter(Boolean) : [];
    return warnings.slice(0, 3).join(" · ");
  }

  async function request(path, progress, onSuccess) {
    if (activeRequest) activeRequest.abort();
    const controller = new AbortController();
    activeRequest = controller;
    setLoading(true);
    showNotice(progress);
    try {
      const fresh = $("refresh-input").checked;
      const cacheKey = `subfinder:search:${path}`;
      if (!fresh) {
        try {
          const saved = JSON.parse(sessionStorage.getItem(cacheKey));
          if (saved && Date.now() - saved.at < 300000) {
            if (activeRequest === controller) onSuccess({ ...saved.data, cache: "browser" });
            return;
          }
        } catch { /* Browser storage can be unavailable. */ }
      } else path += `${path.includes("?") ? "&" : "?"}refresh=1`;
      const response = await fetch(path, { signal: controller.signal, headers: { Accept: "application/json" } });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
      if (!response.ok) {
        throw new Error(clean(data?.error || data?.message || warningsText(data)) || `요청이 실패했습니다 (${response.status}).`);
      }
      if (controller.signal.aborted || activeRequest !== controller) return;
      if (data.status !== "error") {
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })); } catch { /* Storage is optional. */ }
      }
      onSuccess(data);
    } catch (error) {
      if (error.name !== "AbortError" && !controller.signal.aborted && activeRequest === controller) showNotice(error.message || "검색에 실패했습니다.", "error");
    } finally {
      if (activeRequest === controller) {
        activeRequest = null;
        setLoading(false);
      }
    }
  }

  function clearCandidates() {
    candidateSection.hidden = true;
    candidateList.replaceChildren();
    $("candidate-count").textContent = "0";
  }

  function emptyState(message) {
    return element("div", "empty-state", message);
  }

  function showAnime(data) {
    clearCandidates();
    const anime = Array.isArray(data?.anime) ? data.anime : [];
    animeList.replaceChildren();
    animeSection.hidden = false;
    $("anime-count").textContent = String(anime.length);
    if (!anime.length) animeList.append(emptyState("검색된 작품이 없습니다. 정확한 제목이라면 ‘입력 제목으로 자막 찾기’를 사용해 보세요."));
    anime.forEach((item, index) => {
      const row = element("div", "anime-item");
      const title = clean(item.subject) || "제목 없음";
      const select = element("button", "anime-select");
      select.type = "button";
      select.setAttribute("aria-label", `${title} 자막 후보 찾기`);
      select.append(element("span", "anime-ordinal", String(index + 1).padStart(2, "0")));
      const names = element("span", "anime-names");
      names.append(element("span", "anime-title", title));
      if (clean(item.original_subject)) names.append(element("span", "anime-original", clean(item.original_subject)));
      select.append(names);
      select.addEventListener("click", () => searchSelected(item));
      row.append(select);

      const animeNo = Number(item.anime_no ?? item.animeNo);
      if (Number.isSafeInteger(animeNo) && animeNo > 0) {
        const page = element("a", "anime-page-link", "애니시아 페이지 ↗");
        page.href = `https://anissia.net/anime?animeNo=${String(animeNo).padStart(3, "0")}`;
        page.target = "_blank";
        page.rel = "noopener noreferrer";
        page.setAttribute("aria-label", `${title} 애니시아 페이지로 이동`);
        row.append(page);
      }

      const arrow = element("button", "anime-arrow", "→");
      arrow.type = "button";
      arrow.setAttribute("aria-label", `${title} 자막 후보 찾기`);
      arrow.addEventListener("click", () => searchSelected(item));
      row.append(arrow);
      animeList.append(row);
    });
    const warning = warningsText(data);
    showNotice(`${anime.length ? `작품 ${anime.length}개를 찾았습니다. 작품을 선택해 주세요.` : "검색된 작품이 없습니다."}${warning ? ` ${warning}` : ""}`, data?.status === "error" ? "error" : anime.length ? "success" : "info");
    animeSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function makeTag(value, special = false) {
    return element("span", special ? "tag match" : "tag", value);
  }

  function confidenceLabel(value) {
    const labels = { exact: "일치", high: "높음", review: "검토", likely: "추정" };
    const key = clean(value).toLowerCase();
    return labels[key] || clean(value);
  }

  function episodeLabel(candidate) {
    const season = Number(candidate.season);
    const episode = Number(candidate.episode);
    if (Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0) return `시즌 ${season} · ${episode}화`;
    if (Number.isInteger(episode) && episode > 0) return `${episode}화`;
    if (Number.isInteger(season) && season > 0) return `시즌 ${season}`;
    return "회차 미확인";
  }

  function preferenceKey() {
    return `subfinder:release:${clean(englishInput.value || titleInput.value).normalize("NFKC").toLowerCase()}`;
  }

  function rememberFile(item) {
    if (item.provider !== "Jimaku") return;
    try { localStorage.setItem(preferenceKey(), item.file_name); } catch { /* Storage is optional. */ }
  }

  function fileParams(item, mode, entry) {
    const params = new URLSearchParams({ url: item.download_url, name: item.file_name, language: item.language || "", mode });
    if (entry != null) params.set("entry", entry);
    return params;
  }

  async function saveFile(item, mode, entry, extra = {}) {
    const params = fileParams(item, mode, entry);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const path = `/api/file?${params}`;
    let cache, response, saved = false;
    try {
      cache = await caches.open("subfinder-files-v1");
      if (!$("refresh-input").checked) { response = await cache.match(path); saved = Boolean(response); }
    } catch { /* Download also works without browser storage. */ }
    if (!response) {
      response = await fetch(path + ($("refresh-input").checked ? "&refresh=1" : ""));
      if (!response.ok) {
        const error = await response.json();
        throw new Error(warningsText(error) || "파일을 내려받지 못했습니다.");
      }
      if (!response.headers.get("Content-Disposition")?.startsWith("attachment;")) throw new Error("다운로드할 파일을 먼저 선택해 주세요.");
      if (cache) {
        try {
          await cache.put(path, response.clone());
          const keys = await cache.keys();
          for (const key of keys.slice(0, Math.max(0, keys.length - 20))) await cache.delete(key);
        } catch { /* Cache quota must not prevent download. */ }
      }
    }
    let name = item.file_name;
    try { name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("Content-Disposition") || "")?.[1] || name); } catch { /* Keep original. */ }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = element("a");
    link.href = blobUrl; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    rememberFile(item);
    showNotice(saved ? "이 브라우저에 저장된 파일을 내려받았습니다." : "파일을 내려받았습니다. 다음에는 저장본을 우선 사용합니다.", "success");
  }

  function actionButton(text, action) {
    const button = element("button", "", text);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action(); } catch (error) { showNotice(error.message, "error"); }
      finally { button.disabled = false; }
    });
    return button;
  }

  async function inspectFile(item, details, entry) {
    details.hidden = false;
    details.replaceChildren(element("p", "", "파일 내용과 인코딩을 확인하고 있습니다…"));
    const params = fileParams(item, "inspect", entry);
    if ($("refresh-input").checked) params.set("refresh", "1");
    const response = await fetch(`/api/file?${params}`);
    const data = await response.json();
    if (!response.ok) { details.replaceChildren(element("p", "", warningsText(data))); return; }
    details.replaceChildren();
    if (data.archive) {
      details.append(element("p", "", `${data.archive.toUpperCase()} · 자막 또는 폰트를 선택해 주세요.`));
      details.append(actionButton("압축 원본 저장", () => saveFile(item, "original")));
      for (const file of data.entries || []) {
        const row = element("div", "file-entry");
        row.append(element("span", "", file.name));
        row.append(actionButton(file.font ? "폰트 저장" : "내용 확인", () => file.font ? saveFile(item, "original", file.index) : inspectFile(item, details, file.index)));
        details.append(row);
      }
      for (const warning of data.warnings || []) details.append(element("p", "", warning));
      return;
    }
    details.append(element("p", "", data.font ? "폰트 파일 확인 완료" : `${data.format.toUpperCase()} · ${data.encoding} · 대사 ${data.cue_count}개`));
    details.append(actionButton("원본 저장", () => saveFile(item, "original", entry)));
    if (!data.font) details.append(actionButton("UTF-8 사본 저장", () => saveFile(item, "utf8", entry)));
    if (entry != null) details.append(actionButton("ZIP 목록으로", () => inspectFile(item, details)));
    const range = (entry == null ? item.episode_range : null)
      || /(?:^|\D)(\d{1,3})\s*[~～〜–-]\s*(\d{1,3})(?:\D|$)/.exec(data.filename || item.file_name)?.slice(1).map(Number);
    const episode = Number($("episode-input").value);
    if (!data.font && range && episode >= range[0] && episode <= range[1] && range[1] > range[0]) {
      details.append(actionButton(`${episode}화 분리 사본 저장`, () => saveFile(item, "episode", entry, { first: range[0], last: range[1], episode })));
    }
    if (data.fonts?.length) details.append(element("p", "", `사용 글꼴: ${data.fonts.join(", ")}`));
    for (const warning of data.warnings || []) details.append(element("p", "", warning));
  }

  function showCandidates(data, context) {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    candidateList.replaceChildren();
    candidateSection.hidden = false;
    $("candidate-count").textContent = String(candidates.length);
    $("candidate-context").textContent = context;
    if (!candidates.length) candidateList.append(emptyState(sources.length
      ? "확인된 자막 후보가 없습니다. 아래 제작자 원문에서 직접 확인해 보세요."
      : "확인된 자막 후보가 없습니다. 출처 사이트에서 직접 검색하거나 다른 제목으로 다시 검색해 보세요."));
    candidates.forEach((item) => {
      const card = element("article", "candidate-item");
      card.append(element("div", "candidate-source", clean(item.provider) || "출처"));
      const main = element("div", "candidate-main");
      main.append(element("h3", "candidate-title", clean(item.title) || "제목 없음"));
      if (clean(item.file_name)) main.append(element("p", "candidate-filename", clean(item.file_name)));
      const meta = element("div", "candidate-meta");
      meta.append(makeTag(episodeLabel(item)));
      if (clean(item.language)) meta.append(makeTag(clean(item.language).toUpperCase()));
      if (clean(item.creator)) meta.append(makeTag(`제작자 ${clean(item.creator)}`));
      if (clean(item.confidence)) meta.append(makeTag(confidenceLabel(item.confidence), ["exact", "high"].includes(clean(item.confidence).toLowerCase())));
      main.append(meta);
      if (clean(item.note)) main.append(element("p", "candidate-note", clean(item.note)));
      card.append(main);

      const actions = element("div", "candidate-actions");
      const downloadUrl = safeUrl(item.download_url);
      const sourceUrl = safeUrl(item.source_url);
      if (downloadUrl || sourceUrl) {
        const primary = element("a", "candidate-action", downloadUrl ? "파일 열기 ↗" : "원문 열기 ↗");
        primary.href = downloadUrl || sourceUrl;
        primary.target = "_blank";
        primary.rel = "noopener noreferrer";
        primary.addEventListener("click", () => rememberFile(item));
        actions.append(primary);
        if (downloadUrl && sourceUrl && downloadUrl !== sourceUrl) {
          const source = element("a", "plain-link", "원문 페이지 ↗");
          source.href = sourceUrl;
          source.target = "_blank";
          source.rel = "noopener noreferrer";
          actions.append(source);
        }
      } else {
        actions.append(element("span", "tag", "원문 링크 없음"));
      }
      card.append(actions);
      if (downloadUrl) {
        const details = element("div", "file-details"); details.hidden = true;
        const inspect = actionButton("내용 확인 · 저장", () => inspectFile(item, details));
        inspect.className = "candidate-action";
        actions.append(inspect);
        card.append(details);
      }
      if (item.fonts?.length) {
        for (const font of item.fonts) {
          const url = safeUrl(font.download_url || font.url);
          if (url) actions.append(actionButton(`폰트: ${font.name}`, () => saveFile({ ...item, download_url: url, file_name: font.name }, "original")));
        }
      }
      candidateList.append(card);
    });
    sources.forEach((source) => {
      const sourceUrl = safeUrl(source.source_url);
      if (!sourceUrl) return;
      const card = element("article", "candidate-item");
      card.append(element("div", "candidate-source", "제작자 원문"));
      const main = element("div", "candidate-main");
      main.append(element("h3", "candidate-title", clean(source.creator) || "제작자"));
      if (clean(source.note)) main.append(element("p", "candidate-note", clean(source.note)));
      card.append(main);
      const actions = element("div", "candidate-actions");
      const link = element("a", "candidate-action", "원문 열기 ↗");
      link.href = sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actions.append(link);
      const searchUrl = safeUrl(source.search_url);
      if (searchUrl && searchUrl !== sourceUrl) {
        const search = element("a", "plain-link", "블로그 검색 ↗");
        search.href = searchUrl;
        search.target = "_blank";
        search.rel = "noopener noreferrer";
        actions.append(search);
      }
      card.append(actions);
      candidateList.append(card);
    });
    const warning = warningsText(data);
    const cached = ["browser", "hit", "stale"].includes(data.cache) ? " (저장 결과)" : "";
    showNotice(`${candidates.length ? `자막 후보 ${candidates.length}개를 찾았습니다.${cached}` : "확인된 자막 후보가 없습니다."}${warning ? ` ${warning}` : ""}`, data?.status === "error" ? "error" : candidates.length ? "success" : "info");
    candidateSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function discover() {
    const title = requireTitle();
    if (!title) return;
    request(`/api/anime?q=${encodeURIComponent(title)}`, "애니시아 작품을 검색하고 있습니다…", showAnime);
  }

  function searchSubtitles(source, query, context, extras = {}) {
    const params = new URLSearchParams({ source, q: query, ...extras });
    for (const [key, max] of [["season", 99], ["episode", 999]]) {
      const value = clean($(`${key}-input`).value);
      if (!value) continue;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) { showNotice(`${key === "season" ? "시즌" : "회차"}는 1~${max}의 정수로 입력해 주세요.`, "error"); return; }
      params.set(key, value);
    }
    if (source === "jimaku") {
      try { const preferred = localStorage.getItem(preferenceKey()); if (preferred) params.set("preferredFile", preferred); } catch { /* Optional. */ }
    }
    request(`/api/subtitles?${params}`, `${context} 검색 중…`, (data) => showCandidates(data, `${context} 검색 결과입니다. 파일명과 회차를 확인해 주세요.`));
  }

  function searchSelected(item) {
    const title = clean(item.subject);
    if (!title) return;
    titleInput.value = title;
    updateOutboundLinks();
    const animeNo = item.anime_no ?? item.animeNo;
    searchSubtitles("anissia", title, title, animeNo == null ? {} : { animeNo: String(animeNo) });
  }

  function searchManualLink() {
    const title = requireTitle();
    if (!title) return;
    const url = safeUrl(linkInput.value);
    if (!url) {
      showNotice("https://로 시작하는 게시글 또는 파일 주소를 입력해 주세요.", "error");
      linkInput.focus();
      return;
    }
    searchSubtitles("link", title, "입력한 링크", { url });
  }

  function updateOutboundLinks() {
    const koreanTitle = clean(titleInput.value);
    const englishTitle = clean(englishInput.value);
    const title = englishTitle || koreanTitle;
    const slug = encodeURIComponent(title).replace(/%20/g, "+");
    $("opensubtitles-link").href = title
      ? `https://www.opensubtitles.org/ko/search2/moviename-${slug}/sublanguageid-all`
      : "https://www.opensubtitles.org/ko";
    $("pdpop-link").href = koreanTitle
      ? `https://new.pdpop.com/list/ALL?searchKeyword=subject&searchWord=${encodeURIComponent(koreanTitle)}`
      : "https://new.pdpop.com/list/ALL?searchKeyword=subject";
    $("jimaku-link").href = englishTitle ? jimakuSearchUrl(englishTitle) : "https://jimaku.cc/";
    const googleKoParams = new URLSearchParams({
      q: `${koreanTitle} 자막 배포`,
      gl: "US",
      num: "100",
      newwindow: "1",
    });
    $("google-ko-link").href = koreanTitle ? `https://www.google.com/search?${googleKoParams}` : "https://www.google.com";
    const googleEnParams = new URLSearchParams({
      q: `${englishTitle} subtitle download`,
      gl: "US",
      num: "100",
      newwindow: "1",
    });
    $("google-en-link").href = englishTitle ? `https://www.google.com/search?${googleEnParams}` : "https://www.google.com";
  }

  function jimakuSearchUrl(title) {
    return `https://jimaku.cc/opensearch/redirect?anime=true&query=${encodeURIComponent(title)}`;
  }

  $("search-form").addEventListener("submit", (event) => { event.preventDefault(); discover(); });
  $("title-button").addEventListener("click", () => {
    const title = requireTitle();
    if (title) searchSubtitles("anissia", title, "애니시아");
  });
  $("jimaku-button").addEventListener("click", () => {
    const title = requireAnyTitle();
    if (title) searchSubtitles("jimaku", title, "Jimaku 일본어 자막");
  });
  $("pdpop-link").addEventListener("click", (event) => { if (!requireTitle()) event.preventDefault(); });
  $("opensubtitles-link").addEventListener("click", (event) => { if (!requireAnyTitle()) event.preventDefault(); });
  $("jimaku-link").addEventListener("click", (event) => { if (!requireEnglishTitle()) event.preventDefault(); });
  $("google-ko-link").addEventListener("click", (event) => { if (!requireTitle()) event.preventDefault(); });
  $("google-en-link").addEventListener("click", (event) => { if (!requireEnglishTitle()) event.preventDefault(); });
  $("link-button").addEventListener("click", searchManualLink);
  linkInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchManualLink(); } });
  $("cancel-button").addEventListener("click", () => {
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    setLoading(false);
    showNotice("검색을 취소했습니다.");
  });
  for (const input of [titleInput, englishInput]) input.addEventListener("input", updateOutboundLinks);
  updateOutboundLinks();
})();
