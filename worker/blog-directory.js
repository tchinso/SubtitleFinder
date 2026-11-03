import { BLOG_DIRECTORY } from './blog-directory-data.js';

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function identity(title, requestedSeason) {
  const text = String(title || '').normalize('NFKC');
  const seasonPattern = /(?:\bseason\s*(\d+)|시즌\s*(\d+)|(\d+)\s*기(?![가-힣])|(\d+)(?:st|nd|rd|th)\s+season|\bS(\d+)\b)/i;
  const match = seasonPattern.exec(text);
  const season = match ? Number(match.slice(1).find(Boolean)) : requestedSeason || 1;
  return { title: normalize(text.replace(seasonPattern, '')), season };
}

// These are candidate blog entry points, never proof that a subtitle matches.
// Keep the snapshot date and source URLs in blog-directory-data.js when updating it.
export function directoryCaptions(names, season, data = BLOG_DIRECTORY) {
  const wanted = names.filter(Boolean).map(name => identity(name, season));
  const seen = new Set();
  return (data.works || []).filter(work => {
    const workSeason = identity(work.ko).season;
    const matches = [work.ko, work.romaji].filter(Boolean).some(name => {
      const item = identity(name, workSeason);
      return wanted.some(query => query.title.length >= 3 && query.title === item.title && query.season === item.season);
    });
    const key = `${work.maker}:${work.url}`;
    if (!matches || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6).map(work => ({ name: work.maker, website: work.url, directory: true, updated: data.updated }));
}
