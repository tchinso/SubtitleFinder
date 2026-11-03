// Only published counts along an unambiguous TV prequel/sequel chain may change
// the numbering. Unknown counts stop traversal; they are never treated as 13.
const ANILIST = 'https://graphql.anilist.co';
const caches = new WeakMap();
const TV_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

async function queryAniList(query, variables, fetcher) {
  const response = await fetcher(ANILIST, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error(`AniList 응답 오류 (${response.status})`);
  const limit = 256 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('AniList 응답이 너무 큽니다.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('AniList 응답이 비어 있습니다.');
  const decoder = new TextDecoder();
  let text = '', length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('AniList 응답이 너무 큽니다.');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

// Exact native/English/romaji title matching only. A partial search result must
// not silently choose a season for the user.
export async function resolveAniListId(title, fetcher = fetch) {
  if (typeof title !== 'string' || !title.trim() || title.length > 400) return null;
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const data = await queryAniList('query($search:String){Page(perPage:10){media(search:$search,type:ANIME){id title{romaji english native} synonyms}}}', { search: title.trim() }, fetcher);
  const matches = (data?.data?.Page?.media || []).filter(item => [...Object.values(item.title || {}), ...(item.synonyms || [])].some(name => normalize(name) === normalize(title)));
  return matches.length === 1 && Number.isSafeInteger(matches[0].id) && matches[0].id > 0 ? matches[0].id : null;
}

export function verifiedEpisodeAlternatives(episode, info) {
  if (!Number.isInteger(episode) || episode < 1 || !info || !Array.isArray(info.parts) || info.at < 0 || info.at >= info.parts.length) return [];
  const result = new Map();
  for (let start = 0; start <= info.at; start++) {
    let sum = 0;
    for (let at = start; at < info.parts.length; at++) {
      const count = info.parts[at];
      if (!Number.isInteger(count) || count < 1) break;
      if (episode <= sum + count) {
        const local = episode - sum;
        if (at === info.at && local > 0 && local !== episode) result.set(local, { episode: local, limit: count, offset: sum });
        break;
      }
      sum += count;
    }
  }
  const count = info.parts[info.at];
  if (Number.isInteger(count) && episode <= count) {
    let offset = 0;
    for (let previous = info.at - 1; previous >= 0; previous--) {
      const before = info.parts[previous];
      if (!Number.isInteger(before) || before < 1) break;
      offset += before;
      const cumulative = episode + offset;
      result.set(cumulative, { episode: cumulative, limit: count + offset, offset: -offset, minimum: offset + 1 });
    }
  }
  return [...result.values()];
}

export async function loadEpisodeRelations(anilistId, fetcher = fetch, { refresh = false } = {}) {
  const id = Number(anilistId);
  if (!Number.isSafeInteger(id) || id < 1) return { parts: [], at: -1 };
  if (!caches.has(fetcher)) caches.set(fetcher, { values: new Map(), pending: new Map() });
  const cache = caches.get(fetcher), hit = cache.values.get(id);
  if (!refresh && hit && Date.now() - hit.at < 7 * 86400000) return hit.value;
  if (cache.pending.has(id)) return cache.pending.get(id);
  const work = (async () => {
    const mediaCache = new Map();
    async function media(mediaId) {
      if (mediaCache.has(mediaId)) return mediaCache.get(mediaId);
      const value = (await queryAniList('query($id:Int){Media(id:$id,type:ANIME){id format episodes relations{edges{relationType node{id format episodes}}}}}', { id: mediaId }, fetcher))?.data?.Media;
      if (!value || Number(value.id) !== mediaId || !TV_FORMATS.has(value.format)) throw new Error('AniList 작품 정보를 확인하지 못했습니다.');
      mediaCache.set(mediaId, value);
      return value;
    }
    const target = await media(id), seen = new Set([id]);
    async function chain(relation) {
      const out = [];
      let current = target;
      for (let depth = 0; depth < 5; depth++) {
        const nodes = (current.relations?.edges || []).filter(edge => edge.relationType === relation && TV_FORMATS.has(edge.node?.format)).map(edge => edge.node);
        if (nodes.length !== 1 || seen.has(Number(nodes[0].id))) break;
        const next = nodes[0];
        if (!Number.isInteger(next.episodes) || next.episodes < 1) break;
        out.push(next.episodes); seen.add(Number(next.id));
        current = await media(Number(next.id));
      }
      return out;
    }
    const before = (await chain('PREQUEL')).reverse();
    const after = target.episodes ? await chain('SEQUEL') : [];
    const value = { parts: [...before, Number.isInteger(target.episodes) ? target.episodes : null, ...after], at: before.length };
    cache.values.set(id, { value, at: Date.now() });
    if (cache.values.size > 64) cache.values.delete(cache.values.keys().next().value);
    return value;
  })();
  cache.pending.set(id, work);
  try { return await work; } finally { cache.pending.delete(id); }
}
