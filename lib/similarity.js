'use strict';

/**
 * Local, dependency-free duplicate detection engine.
 *
 * Works for Hebrew and English (and any other letter-based script). It builds
 * an IDF-weighted vector (unigrams + bigrams, title weighted above body
 * snippet) and compares topics by cosine similarity, with a guard that
 * requires enough shared meaningful terms so that a single common keyword
 * never produces a "match".
 */

const RAW_STOPWORDS = [
	// English
	'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as',
	'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'it', 'its', 'this', 'that', 'these',
	'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'what', 'which', 'who',
	'how', 'why', 'when', 'where', 'can', 'could', 'should', 'would', 'will', 'there', 'any', 'some', 'not',
	'no', 'so', 'from', 'into', 'than', 'then', 'also', 'just', 'have', 'has', 'had', 'get', 'got', 'please',
	'help', 'hello', 'hi', 'thanks', 'thank',
	// Hebrew
	'את', 'של', 'על', 'עם', 'אל', 'מן', 'אם', 'או', 'גם', 'כי', 'לא', 'כן', 'זה', 'זו', 'זאת', 'אלה', 'אלו',
	'הוא', 'היא', 'הם', 'הן', 'אני', 'אנו', 'אנחנו', 'אתה', 'את', 'אתם', 'אתן', 'מה', 'מי', 'איך', 'למה',
	'מתי', 'איפה', 'האם', 'יש', 'אין', 'היה', 'היתה', 'להיות', 'כל', 'עוד', 'רק', 'כמו', 'אבל', 'אז', 'שלי',
	'שלך', 'שלו', 'שלה', 'שלנו', 'לי', 'לך', 'לו', 'לה', 'לנו', 'בבקשה', 'תודה', 'שלום', 'עזרה', 'מישהו',
	'אפשר', 'צריך', 'צריכה', 'רוצה', 'יכול', 'יכולה'
];

const FINAL_FORMS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
// 'מ' is deliberately not stripped: it is usually a root letter (מקרר, מגדיר)
const HEBREW_PREFIXES = new Set(['ו', 'ה', 'ב', 'כ', 'ל', 'ש']);

function normalize(text) {
	if (!text) {
		return '';
	}
	return String(text)
		.normalize('NFKC')
		.replace(/[֑-ׇ]/g, '') // Hebrew niqqud and cantillation
		.replace(/[ךםןףץ]/g, ch => FINAL_FORMS[ch])
		.toLowerCase();
}

// stopwords go through the same normalisation as input, otherwise words with final letters never match
const STOPWORDS = new Set(RAW_STOPWORDS.map(normalize));

function stemEnglish(word) {
	if (!/^[a-z]+$/.test(word) || word.length < 5) {
		return word;
	}
	return word
		.replace(/(ing|edly|ed|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''))
		.replace(/(.)\1$/, '$1');
}

function stemHebrew(word) {
	if (!/^[א-ת]+$/.test(word)) {
		return word;
	}
	let w = word;
	// strip one prefix letter while keeping a 3+ letter remainder; stacked prefixes are left alone
	// because the second letter is far more often a root letter (לבנות, מבנה)
	if (w.length > 3 && HEBREW_PREFIXES.has(w[0])) {
		w = w.slice(1);
	}
	return w;
}

function stem(word) {
	return stemEnglish(stemHebrew(word));
}

/** Meaningful words in order, each with its stemmed form and its normalised raw form. */
function analyzeWords(text) {
	const norm = normalize(text).replace(/https?:\/\/\S+/g, ' ');
	const raw = norm.match(/[\p{L}\p{N}]+/gu) || [];
	const out = [];
	for (const w of raw) {
		if (STOPWORDS.has(w) || (w.length < 2 && !/\d/.test(w))) {
			continue;
		}
		const s = stem(w);
		if (s.length >= 2 || /\d/.test(s)) {
			out.push({ stem: s, raw: w });
		}
	}
	return out;
}

/** Returns meaningful stemmed tokens, preserving order. */
function tokenize(text) {
	return analyzeWords(text).map(w => w.stem);
}

function bigrams(tokens) {
	const out = [];
	for (let i = 0; i < tokens.length - 1; i++) {
		out.push(`${tokens[i]} ${tokens[i + 1]}`);
	}
	return out;
}

const TITLE_WEIGHT = 1;
const BIGRAM_WEIGHT = 1;
const BODY_WEIGHT = 0.35;
const TRIGRAM_WEIGHT = 0.3;
// Raw cosine rarely exceeds ~0.7 even for the same question worded differently, so it is
// rescaled to make the 0-1 score (and the percentage shown to users) meaningful.
const ROOT_WEIGHT = 0.6;
const COSINE_FULL_SCALE = 0.7;

/** Character trigrams catch morphological variants (Hebrew conjugations, plurals, English suffixes). */
function trigrams(token) {
	const out = [];
	if (token.length < 4 || /^\d+$/.test(token)) {
		return out;
	}
	for (let i = 0; i <= token.length - 3; i++) {
		out.push(token.slice(i, i + 3));
	}
	return out;
}

/**
 * Rough Hebrew consonant skeleton: drops vav/yod (matres lectionis) after the first letter and a trailing
 * he/tav, so e.g. "לבנות" and "בנייה" both reduce to "בנ". Weak on its own, so it is only a low-weight
 * feature that still needs other shared terms to count (see the shared-terms guard).
 */
function root(token) {
	if (!/^[\u05D0-\u05EA]+$/.test(token) || token.length < 4) {
		return '';
	}
	let r = token[0] + token.slice(1).replace(/[וי]/g, '');
	if (r.length > 2) {
		r = r.replace(/[הת]$/, '');
	}
	return r.length >= 2 ? r : '';
}

/** Builds a sparse feature map { feature: tf-weight } for a topic. */
function features(title, snippet) {
	const map = new Map();
	const add = (key, w) => map.set(key, Math.max(map.get(key) || 0, w));
	const words = analyzeWords(title);
	const tTokens = words.map(w => w.stem);
	// per word: roots of the raw form and of the stemmed form (the prefix letter may be a root letter)
	const rootGroups = words.map(w => Array.from(new Set([root(w.raw), root(w.stem)].filter(Boolean))));
	tTokens.forEach(t => add(t, TITLE_WEIGHT));
	bigrams(tTokens).forEach(b => add(`_b:${b}`, BIGRAM_WEIGHT));
	tTokens.forEach(tok => trigrams(tok).forEach(g => add(`_c:${g}`, TRIGRAM_WEIGHT)));
	rootGroups.forEach(g => g.forEach(r => add(`_r:${r}`, ROOT_WEIGHT)));
	const titleMap = new Map(map);
	tokenize(snippet).slice(0, 80).forEach(t => add(t, BODY_WEIGHT));
	return { map, titleMap, titleTokens: new Set(tTokens), normTitle: tTokens.join(' '), words, rootGroups };
}

function weightOf(index, f, w, unseenIdf) {
	return w * (index.df.has(f) ? index.idf(f) : unseenIdf);
}

class SimilarityIndex {
	constructor() {
		this.docs = new Map(); // id -> { id, feats, ... }
		this.df = new Map();
	}

	get size() {
		return this.docs.size;
	}

	add(doc) {
		this.remove(doc.id);
		const feats = features(doc.title, doc.snippet);
		this.docs.set(String(doc.id), { id: String(doc.id), feats, meta: doc.meta || {} });
		for (const key of feats.map.keys()) {
			this.df.set(key, (this.df.get(key) || 0) + 1);
		}
	}

	remove(id) {
		const key = String(id);
		const existing = this.docs.get(key);
		if (!existing) {
			return;
		}
		for (const f of existing.feats.map.keys()) {
			const n = (this.df.get(f) || 1) - 1;
			if (n <= 0) {
				this.df.delete(f);
			} else {
				this.df.set(f, n);
			}
		}
		this.docs.delete(key);
	}

	has(id) {
		return this.docs.has(String(id));
	}

	idf(feature) {
		const n = this.docs.size;
		const df = this.df.get(feature) || 0;
		return Math.log(1 + (n - df + 0.5) / (df + 0.5));
	}

	/**
	 * @param {{title: string, snippet?: string}} query
	 * @param {{limit?: number, minScore?: number, exclude?: Set<string>, allow?: (meta) => boolean}} opts
	 * @returns {Array<{id, score, sharedTerms, meta}>} sorted by score desc
	 */
	search(query, opts = {}) {
		const { limit = 10, minScore = 0.3, exclude, allow } = opts;
		const unseen = Math.log(1 + this.docs.size + 0.5);
		const weigh = (map) => {
			const out = new Map();
			let norm = 0;
			for (const [f, w] of map) {
				const weight = weightOf(this, f, w, unseen);
				out.set(f, weight);
				norm += weight * weight;
			}
			return { weights: out, norm: Math.sqrt(norm) || 1 };
		};
		const q = features(query.title, query.snippet);
		if (!q.map.size) {
			return [];
		}
		const qFull = weigh(q.map);
		const qTitle = weigh(q.titleMap);

		const cosine = (qSide, dMap) => {
			let dot = 0;
			let dNorm = 0;
			for (const [f, w] of dMap) {
				const weight = w * this.idf(f);
				dNorm += weight * weight;
				if (qSide.weights.has(f)) {
					dot += weight * qSide.weights.get(f);
				}
			}
			return dot ? dot / (qSide.norm * (Math.sqrt(dNorm) || 1)) : 0;
		};

		const results = [];
		for (const doc of this.docs.values()) {
			if (exclude && exclude.has(doc.id)) {
				continue;
			}
			if (allow && !allow(doc.meta)) {
				continue;
			}
			const shared = [];
			for (const f of doc.feats.map.keys()) {
				if (qFull.weights.has(f) && !f.startsWith('_')) {
					shared.push(f);
				}
			}
			// A root match counts as a shared term only for query words that did not already match literally,
			// so one word is never counted twice (as itself and as its root).
			let rootMatches = 0;
			q.words.forEach((w, i) => {
				if (!doc.feats.map.has(w.stem) && q.rootGroups[i].some(r => doc.feats.map.has(`_r:${r}`))) {
					rootMatches++;
				}
			});
			const sharedCount = shared.length + rootMatches;
			if (!sharedCount) {
				continue;
			}
			// Title-to-title similarity is the primary signal; body text can only add to it.
			let score = Math.min(1, Math.max(cosine(qFull, doc.feats.map), cosine(qTitle, doc.feats.titleMap)) / COSINE_FULL_SCALE);

			// Guard: sharing a single keyword is never a real match unless one side only has one term.
			const minTerms = Math.min(q.titleTokens.size, doc.feats.titleTokens.size) <= 1 ? 1 : 2;
			if (sharedCount < minTerms) {
				score = Math.min(score, 0.2);
			}
			if (q.normTitle && q.normTitle === doc.feats.normTitle) {
				score = 1;
			}
			if (score >= minScore) {
				results.push({ id: doc.id, score: Math.min(1, score), sharedTerms: shared, meta: doc.meta });
			}
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}
}

const DEFAULT_THRESHOLDS = { duplicate: 0.58, related: 0.36 };

function classify(score, thresholds = DEFAULT_THRESHOLDS) {
	if (score >= thresholds.duplicate) {
		return 'duplicate';
	}
	if (score >= thresholds.related) {
		return 'related';
	}
	return 'weak';
}

module.exports = {
	normalize,
	tokenize,
	features,
	classify,
	SimilarityIndex,
	DEFAULT_THRESHOLDS,
};
