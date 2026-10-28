// Tokenizer for BM25, ported from EverOS component/tokenizer/jieba_provider.py (Apache-2.0).
// Search-mode segmentation (cut_for_search), whitespace/short tokens dropped, small bilingual stopword set.
// Write side (index) and query side must use the same function — that symmetry is what makes BM25 recall work.
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

const STOPWORDS = new Set(('the a an and or but if of to in on at by for with as is are was were be been being do does did has have had this that these those it its ' +
  '的 了 和 是 在 我 你 他 她 它 们 也 就 都 而 及 与 或 着 过 又 很 把 被 让 给 对 这 那 有 不 没').split(' '));
const MIN_TOKEN_LENGTH = 2;

let jieba = null;
export function tokenize(text, { minLength = MIN_TOKEN_LENGTH } = {}) {
  jieba ??= Jieba.withDict(dict);
  const out = [];
  for (const raw of jieba.cutForSearch(String(text ?? '').normalize('NFKC'), true)) {
    const token = raw.trim().toLowerCase();
    if (!token || [...token].length < minLength || STOPWORDS.has(token)) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue; // pure punctuation
    out.push(token);
  }
  return out;
}
export const tokenizeJoined = text => tokenize(text).join(' ');
