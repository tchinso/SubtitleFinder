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
  const searchButtons = [$("discover-button"), $("title-button"), $("bigfile-button"), $("link-button")];
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
    showNotice("Bigfile, Jimaku, Google 미국 검색에는 영문 또는 로마자 제목을 입력해 주세요.", "error");
    englishInput.focus();
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
      onSuccess(data);
    } catch (error) {
      if (error.name !== "AbortError") showNotice(error.message || "검색에 실패했습니다.", "error");
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
      const button = element("button", "anime-item");
      button.type = "button";
      button.append(element("span", "anime-ordinal", String(index + 1).padStart(2, "0")));
      const names = element("span", "anime-names");
      names.append(element("span", "anime-title", clean(item.subject) || "제목 없음"));
      if (clean(item.original_subject)) names.append(element("span", "anime-original", clean(item.original_subject)));
      button.append(names, element("span", "anime-arrow", "→"));
      button.addEventListener("click", () => searchSelected(item));
      animeList.append(button);
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

  function showCandidates(data, context) {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    candidateList.replaceChildren();
    candidateSection.hidden = false;
    $("candidate-count").textContent = String(candidates.length);
    $("candidate-context").textContent = context;
    if (!candidates.length) candidateList.append(emptyState("확인된 자막 후보가 없습니다. 출처 사이트에서 직접 검색하거나 다른 제목으로 다시 검색해 보세요."));
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
      candidateList.append(card);
    });
    const warning = warningsText(data);
    showNotice(`${candidates.length ? `자막 후보 ${candidates.length}개를 찾았습니다.` : "확인된 자막 후보가 없습니다."}${warning ? ` ${warning}` : ""}`, data?.status === "error" ? "error" : candidates.length ? "success" : "info");
    candidateSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function discover() {
    const title = requireTitle();
    if (!title) return;
    request(`/api/anime?q=${encodeURIComponent(title)}`, "애니시아 작품을 검색하고 있습니다…", showAnime);
  }

  function searchSubtitles(source, query, context, extras = {}) {
    const params = new URLSearchParams({ source, q: query, ...extras });
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
    const title = clean(englishInput.value) || clean(titleInput.value);
    const englishTitle = clean(englishInput.value);
    const language = $("language-select").value;
    const slug = encodeURIComponent(title).replace(/%20/g, "+");
    $("opensubtitles-link").href = title
      ? `https://www.opensubtitles.org/ko/search2/moviename-${slug}/sublanguageid-${language}`
      : "https://www.opensubtitles.org/ko";
    $("jimaku-direct-link").href = title ? jimakuSearchUrl(title) : "https://jimaku.cc/";
    $("jimaku-button").href = englishTitle ? jimakuSearchUrl(englishTitle) : "https://jimaku.cc/";
    const googleParams = new URLSearchParams({
      q: `${englishTitle} subtitle download`,
      gl: "US",
      num: "100",
      newwindow: "1",
    });
    $("google-link").href = englishTitle ? `https://www.google.com/search?${googleParams}` : "https://www.google.com";
  }

  function jimakuSearchUrl(title) {
    return `https://jimaku.cc/opensearch/redirect?anime=true&query=${encodeURIComponent(title)}`;
  }

  $("search-form").addEventListener("submit", (event) => { event.preventDefault(); discover(); });
  $("title-button").addEventListener("click", () => {
    const title = requireTitle();
    if (title) searchSubtitles("anissia", title, "애니시아");
  });
  $("bigfile-button").addEventListener("click", () => {
    const title = requireEnglishTitle();
    if (title) searchSubtitles("bigfile", title, "Bigfile");
  });
  $("jimaku-button").addEventListener("click", (event) => {
    const title = requireEnglishTitle();
    if (!title) { event.preventDefault(); return; }
    showNotice("Jimaku 검색을 새 탭에서 열었습니다. 사이트에서 일본어 자막을 확인해 주세요.");
  });
  $("google-link").addEventListener("click", (event) => {
    if (!requireEnglishTitle()) event.preventDefault();
  });
  $("link-button").addEventListener("click", searchManualLink);
  linkInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchManualLink(); } });
  $("cancel-button").addEventListener("click", () => {
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    setLoading(false);
    showNotice("검색을 취소했습니다.");
  });
  for (const input of [titleInput, englishInput, $("language-select")]) input.addEventListener("input", updateOutboundLinks);
  updateOutboundLinks();
})();
