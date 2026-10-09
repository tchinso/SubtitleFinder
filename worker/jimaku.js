const JIMAKU_ORIGIN = 'https://jimaku.cc';

export function jimakuSearchUrl(q) {
  const url = new URL('/opensearch/redirect', JIMAKU_ORIGIN);
  url.searchParams.set('anime', 'true');
  url.searchParams.set('query', String(q ?? '').trim());
  return url.toString();
}

export async function searchJimaku({ q } = {}) {
  const title = typeof q === 'string' ? q.trim() : '';
  if (!title) {
    return { status: 'error', warnings: ['검색할 제목을 입력해 주세요.'], candidates: [] };
  }

  return {
    status: 'review',
    warnings: [],
    candidates: [{
      provider: 'Jimaku',
      title,
      file_name: 'Jimaku에서 직접 검색',
      source_url: jimakuSearchUrl(title),
      download_url: '',
      language: 'ja',
      season: null,
      episode: null,
      confidence: 'review',
      note: '영문·로마자 제목으로 일본어 자막을 검색합니다. 사이트에서 파일을 확인해 주세요.',
    }],
  };
}
