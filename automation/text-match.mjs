// 检索的共用算法：会话检索（agent search）与项目检索（projects search）用同一份，行为一致。纯算术，无模型。
// 两步：先看全部词是否都出现（子串）；一个都凑不齐时（常是凭记忆整句来问），改按查询里的字词片段近似匹配。
// 全匹配的排序由各检索自己定（会话按标题和最近活动，项目按词在标题／摘要／正文的位置）；近似匹配的打分在这里。
export const searchTerms = query => String(query || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase().split(' ').filter(Boolean);

// Pieces of one query word for the approximate search. Hits among very common function characters (的、了、是…) are not pieces: they match everything.
const FUNCTION_CHARS = /[的了是我你他她它们这那有过吗么什怎在也都就和与及或但而所以]/u;
export const piecesOf = term => term.split(/[^\p{L}\p{N}_]+/u).filter(Boolean).flatMap(part => {
  if ([...part].length <= 4) return [part];
  return (part.match(/[a-z0-9_]{2,}|\p{Script=Han}+/gu) || []).flatMap(run => {
    if (!/\p{Script=Han}/u.test(run)) return [run];
    const chars = [...run];
    return chars.slice(0, -1).map((c, i) => c + chars[i + 1]).filter(g => !FUNCTION_CHARS.test(g));
  });
});

// Score each doc ({low: lowercased text, …}) by the pieces of the query it contains. Short words stay whole, longer ones are cut into two-character pieces;
// a piece found in few docs counts for more than one found everywhere. Returns the piece weights and the docs scoring at least minScore (score 0–1, with hit pieces).
export function nearMatches(docs, terms, minScore = 0.1) {
  const pieces = [...new Set(terms.flatMap(piecesOf))];
  const weight = Object.fromEntries(pieces.map(p => { const df = docs.filter(d => d.low.includes(p)).length; return [p, df ? Math.log(1 + docs.length / df) : 0]; }));
  const total = pieces.reduce((a, p) => a + weight[p], 0);
  const scored = total ? docs.map(d => ({ ...d, hit: pieces.filter(p => d.low.includes(p)), score: pieces.reduce((a, p) => a + (d.low.includes(p) ? weight[p] : 0), 0) / total })).filter(d => d.score >= minScore) : [];
  return { weight, scored };
}
