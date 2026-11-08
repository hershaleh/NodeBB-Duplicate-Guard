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
const SUFFIX_WEIGHT = 0.5;
// how much of a literal match an alternative match (suffix/typo vs. weak consonant root) is worth
const ALT_MATCH_FACTOR = 0.8;
const ROOT_MATCH_FACTOR = 0.55;
const TYPO_WEIGHT = 0.85;
const LAYOUT_PENALTY = 0.92;
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


/* ------------------------------------------------------------ synonyms */

// Conservative built-in groups of words that mean (nearly) the same thing in forum questions.
// Admins can add their own in the plugin settings (one group per line, comma separated).
const DEFAULT_SYNONYMS = [
	['בעיה', 'תקלה', 'שגיאה', 'באג', 'problem', 'issue', 'error', 'bug', 'fault'],
	['מחשב', 'לפטופ', 'נייד', 'computer', 'laptop', 'pc'],
	['טלפון', 'פלאפון', 'סלולרי', 'נייד', 'phone', 'mobile', 'smartphone'],
	['התקנה', 'להתקין', 'התקן', 'install', 'installation', 'setup'],
	['הגדרה', 'להגדיר', 'הגדרות', 'קונפיגורציה', 'configure', 'configuration', 'settings'],
	['מחיר', 'עלות', 'תשלום', 'price', 'cost', 'pricing'],
	['המלצה', 'המלצות', 'מומלץ', 'recommend', 'recommendation', 'suggest', 'suggestion'],
	['עדכון', 'לעדכן', 'שדרוג', 'update', 'upgrade'],
	['מחיקה', 'למחוק', 'הסרה', 'להסיר', 'delete', 'remove', 'removal'],
	['סיסמה', 'סיסמא', 'קוד', 'password', 'passcode'],
	['אינטרנט', 'רשת', 'גלישה', 'internet', 'network', 'wifi'],
	['איטי', 'לאט', 'תקוע', 'slow', 'laggy', 'lag'],
	['נתב', 'ראוטר', 'router'],
	['חשבון', 'משתמש', 'account', 'user'],
	['הורדה', 'להוריד', 'download'],
	['בנייה', 'בניה', 'לבנות', 'build', 'construction'],
	['תמונה', 'תמונות', 'צילום', 'picture', 'image', 'photo'],
	['סרטון', 'וידאו', 'וידיאו', 'סרט', 'video', 'movie'],
	['מייל', 'אימייל', 'דואל', 'email', 'mail'],
	['קנייה', 'קניה', 'לקנות', 'רכישה', 'buy', 'purchase'],
];

let synonymMap = new Map(); // word form -> group id

function buildSynonymMap(groups) {
	const map = new Map();
	groups.forEach((group, gi) => {
		group.forEach((w) => {
			const n = normalize(String(w).trim());
			if (!n || /\s/.test(n)) {
				return; // single words only
			}
			[n, stem(n)].forEach((k) => { if (!map.has(k)) { map.set(k, `g${gi}`); } });
		});
	});
	return map;
}

/** Install admin-defined synonym groups (text, one group per line) on top of the defaults. */
function setSynonyms(text) {
	const custom = String(text || '').split(/\r?\n/)
		.map(line => line.split(/[,،;]/).map(x => x.trim()).filter(Boolean))
		.filter(g => g.length > 1);
	synonymMap = buildSynonymMap(DEFAULT_SYNONYMS.concat(custom));
}

setSynonyms('');

/* -------------------------------------------------------- suffixes, typos */

const HEBREW_SUFFIXES = ['יות', 'ימ', 'ות', 'תי', 'נו', 'כמ', 'הנ', 'ית', 'יה', 'ה', 'ת', 'י', 'ו'].sort((a, b) => b.length - a.length);

/** Plural / possessive / feminine ending removed (Hebrew only); '' when nothing sensible remains. */
function suffixStem(word) {
	if (!/^[א-ת]+$/.test(word)) {
		return '';
	}
	for (const suf of HEBREW_SUFFIXES) {
		if (word.endsWith(suf) && word.length - suf.length >= 3) {
			return word.slice(0, -suf.length);
		}
	}
	return '';
}

function deletes(word) {
	const out = [];
	for (let i = 0; i < word.length; i++) {
		out.push(word.slice(0, i) + word.slice(i + 1));
	}
	return out;
}

function within1(a, b) {
	if (a === b) {
		return true;
	}
	if (Math.abs(a.length - b.length) > 1) {
		return false;
	}
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) {
		i++;
	}
	if (a.length === b.length) {
		return a.slice(i + 1) === b.slice(i + 1) // substitution
			|| (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)); // transposition
	}
	const [long, short] = a.length > b.length ? [a, b] : [b, a];
	return long.slice(i + 1) === short.slice(i);
}

const typoEligible = w => (/^[א-ת]+$/.test(w) ? w.length >= 5 : /^[a-z]+$/.test(w) && w.length >= 6);

/* ----------------------------------------------------- keyboard layouts */

// Standard Israeli (SI-1452) layout: what a Hebrew keyboard types when the OS layout is English, and back.
const EN_TO_HE = {
	q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ', a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י',
	j: 'ח', k: 'ל', l: 'ך', z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ', ';': 'ף',
};
const HE_TO_EN = {};
Object.keys(EN_TO_HE).forEach((k) => { HE_TO_EN[EN_TO_HE[k]] = k; });

function convertLayout(text) {
	const t = String(text || '');
	const letters = t.replace(/[^\p{L},.;]/gu, '');
	if (letters.length < 4) {
		return '';
	}
	const hasHebrew = /[א-ת]/.test(t);
	const hasLatin = /[A-Za-z]/.test(t);
	if (hasHebrew === hasLatin) {
		return ''; // mixed or neither: not a layout slip
	}
	const map = hasLatin ? EN_TO_HE : HE_TO_EN;
	let converted = 0;
	const out = t.toLowerCase().split('').map((ch) => {
		if (map[ch]) {
			converted++;
			return map[ch];
		}
		return ch;
	}).join('');
	return converted >= 4 ? out : '';
}

/** Builds a sparse feature map { feature: tf-weight } for a topic. */
function features(title, snippet) {
	const map = new Map();
	const add = (key, w) => map.set(key, Math.max(map.get(key) || 0, w));
	const words = analyzeWords(title);
	// words in a synonym group are replaced by one canonical token, so they match like identical words
	words.forEach((w) => {
		const group = [w.stem, w.raw, suffixStem(w.stem)].filter(Boolean).map(f => synonymMap.get(f)).find(Boolean);
		w.token = group ? `=${group}` : w.stem;
	});
	const tTokens = words.map(w => w.token);
	// per word, "alternative" keys that let different surface forms of one word meet: consonant roots (of the raw
	// and the prefix-stripped form) and suffix-stripped forms
	const altGroups = words.map((w) => {
		if (w.token.startsWith('=')) {
			return [];
		}
		const keys = new Set();
		[root(w.raw), root(w.stem)].filter(Boolean).forEach(r => keys.add(`_r:${r}`));
		[suffixStem(w.stem), suffixStem(w.raw)].filter(Boolean).forEach(x => keys.add(`_x:${x}`));
		return Array.from(keys);
	});
	tTokens.forEach(t => add(t, TITLE_WEIGHT));
	bigrams(tTokens).forEach(b => add(`_b:${b}`, BIGRAM_WEIGHT));
	// trigrams come from the real word even when a synonym replaced it, so morphology still bridges forms
	words.forEach(w => trigrams(w.stem).forEach(g => add(`_c:${g}`, TRIGRAM_WEIGHT)));
	altGroups.forEach(g => g.forEach(k => add(k, k.startsWith('_x:') ? SUFFIX_WEIGHT : ROOT_WEIGHT)));
	const titleMap = new Map(map);
	tokenize(snippet).slice(0, 80).forEach(t => add(t, BODY_WEIGHT));
	return { map, titleMap, titleTokens: new Set(tTokens), normTitle: tTokens.join(' '), words, altGroups };
}

function weightOf(index, f, w, unseenIdf) {
	return w * (index.df.has(f) ? index.idf(f) : unseenIdf);
}

class SimilarityIndex {
	constructor() {
		this.docs = new Map(); // id -> { id, feats, ... }
		this.df = new Map();
		this.vocab = new Map(); // delete-variant -> Set(words), for typo correction
	}

	get size() {
		return this.docs.size;
	}

	add(doc) {
		this.remove(doc.id);
		const feats = features(doc.title, doc.snippet);
		this.docs.set(String(doc.id), { id: String(doc.id), feats, meta: doc.meta || {} });
		for (const w of feats.titleTokens) {
			if (typoEligible(w)) {
				[w, ...deletes(w)].forEach((k) => {
					const set = this.vocab.get(k) || new Set();
					set.add(w);
					this.vocab.set(k, set);
				});
			}
		}
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
		const base = this._searchOne(query, { ...opts, limit: (opts.limit || 10) * 2 });
		// someone typing Hebrew with an English keyboard layout (or the reverse) still finds their topic
		const alt = convertLayout(query.title);
		if (!alt) {
			return base.slice(0, opts.limit || 10);
		}
		const best = new Map(base.map(r => [r.id, r]));
		const altQuery = { title: alt, snippet: query.snippet };
		for (const r of this._searchOne(altQuery, { ...opts, limit: (opts.limit || 10) * 2 })) {
			const penalised = { ...r, score: r.score * LAYOUT_PENALTY };
			if (penalised.score >= (opts.minScore === undefined ? 0.3 : opts.minScore)
				&& (!best.has(r.id) || best.get(r.id).score < penalised.score)) {
				best.set(r.id, penalised);
			}
		}
		return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, opts.limit || 10);
	}

	/**
	 * @param {{title: string, snippet?: string}} query
	 * @param {{limit?: number, minScore?: number, exclude?: Set<string>, allow?: (meta) => boolean}} opts
	 * @returns {Array<{id, score, sharedTerms, meta}>} sorted by score desc
	 */
	_searchOne(query, opts = {}) {
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
		// typo correction: a query word the index has never seen is replaced by close vocabulary words
		const typoKeys = new Set();
		const typoByWord = q.words.map((w) => {
			if (this.df.has(w.token) || !typoEligible(w.token)) {
				return [];
			}
			const found = new Set();
			[w.token, ...deletes(w.token)].forEach((k) => {
				(this.vocab.get(k) || []).forEach((cand) => {
					if (cand !== w.token && this.df.has(cand) && within1(w.token, cand)) { found.add(cand); }
				});
			});
			return Array.from(found).slice(0, 3);
		});
		typoByWord.forEach(c => c.forEach((cand) => {
			typoKeys.add(cand);
			q.map.set(cand, Math.max(q.map.get(cand) || 0, TYPO_WEIGHT));
			q.titleMap.set(cand, Math.max(q.titleMap.get(cand) || 0, TYPO_WEIGHT));
		}));
		const qFull = weigh(q.map);
		const qTitle = weigh(q.titleMap);

		const cosine = (qSide, dMap, bonus = 0) => {
			let dot = bonus;
			let dNorm = 0;
			for (const [f, w] of dMap) {
				const weight = w * this.idf(f);
				dNorm += weight * weight;
				if (qSide.weights.has(f)) {
					dot += weight * qSide.weights.get(f);
				}
			}
			return dot ? Math.min(1, dot / (qSide.norm * (Math.sqrt(dNorm) || 1))) : 0;
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
				if (qFull.weights.has(f) && !f.startsWith('_') && !typoKeys.has(f)) {
					shared.push(f);
				}
			}
			// Alternative matches (root, suffix, typo-corrected) count as shared terms and add a partial literal-like
			// contribution, but only for query words that did not already match literally.
			let rootMatches = 0;
			let bonusFull = 0;
			let bonusTitle = 0;
			q.words.forEach((w, i) => {
				if (doc.feats.map.has(w.token)) {
					return;
				}
				// a suffix-stripped query form can meet the other topic's plain word, and vice versa
				const alt = q.altGroups[i].filter(k => doc.feats.map.has(k) || (k.startsWith('_x:') && doc.feats.map.has(k.slice(3))));
				if (doc.feats.map.has(`_x:${w.token}`)) {
					alt.push(`_x:${w.token}`);
				}
				const typo = typoByWord[i].some(c => doc.feats.map.has(c));
				if (!alt.length && !typo) {
					return;
				}
				rootMatches++;
				const factor = typo || alt.some(k => k.startsWith('_x:')) ? ALT_MATCH_FACTOR : ROOT_MATCH_FACTOR;
				const wf = qFull.weights.get(w.token) || 0;
				const wt = qTitle.weights.get(w.token) || 0;
				bonusFull += factor * wf * wf;
				bonusTitle += factor * wt * wt;
			});
			const sharedCount = shared.length + rootMatches;
			if (!sharedCount) {
				continue;
			}
			// Title-to-title similarity is the primary signal; body text can only add to it.
			let score = Math.min(1, Math.max(cosine(qFull, doc.feats.map, bonusFull), cosine(qTitle, doc.feats.titleMap, bonusTitle)) / COSINE_FULL_SCALE);

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
	setSynonyms,
	convertLayout,
	tokenize,
	features,
	classify,
	SimilarityIndex,
	DEFAULT_THRESHOLDS,
};
