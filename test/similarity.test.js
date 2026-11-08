'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SimilarityIndex, tokenize, normalize, classify } = require('../lib/similarity');

function build(docs) {
	const idx = new SimilarityIndex();
	docs.forEach(d => idx.add(d));
	return idx;
}

const corpus = [
	{ id: 1, title: 'איך מגדירים נתב ביתי לחיבור סיבים', snippet: 'קניתי נתב חדש ואני לא מצליח להגדיר אותו' },
	{ id: 2, title: 'המלצה על מקרר חדש למטבח קטן', snippet: 'מחפש מקרר חסכוני בחשמל' },
	{ id: 3, title: 'How do I reset my router password?', snippet: 'I forgot the admin password of my home router' },
	{ id: 4, title: 'Best pizza places in Tel Aviv', snippet: 'Looking for good pizza' },
	{ id: 5, title: 'בעיה בחיבור לאינטרנט בסיבים', snippet: 'האינטרנט נופל כל כמה דקות' },
	...Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, title: `נושא כללי מספר ${i} על טיולים בצפון`, snippet: '' })),
];

test('normalize strips niqqud and final letters', () => {
	assert.strictEqual(normalize('שָׁלוֹם'), normalize('שלום'));
	assert.strictEqual(normalize('מלך'), 'מלכ');
});

test('tokenize drops stopwords and strips Hebrew prefixes', () => {
	assert.deepStrictEqual(tokenize('איך מגדירים את הנתב'), ['מגדירימ', 'נתב']);
	assert.ok(!tokenize('How do I reset the router').includes('the'));
});

test('same question worded differently ranks first and is a duplicate', () => {
	const idx = build(corpus);
	const [top] = idx.search({ title: 'איך להגדיר נתב ביתי לסיבים?', snippet: 'קניתי נתב ולא מצליח' }, { minScore: 0.2 });
	assert.strictEqual(top.id, '1');
	assert.ok(top.score > 0.5, `score was ${top.score}`);
});

test('English duplicate is found', () => {
	const idx = build(corpus);
	const [top] = idx.search({ title: 'Reset router admin password', snippet: '' }, { minScore: 0.2 });
	assert.strictEqual(top.id, '3');
});

test('exact normalized title is a perfect match', () => {
	const idx = build(corpus);
	const [top] = idx.search({ title: 'best PIZZA places in tel aviv!!' });
	assert.strictEqual(top.id, '4');
	assert.strictEqual(top.score, 1);
	assert.strictEqual(classify(top.score), 'duplicate');
});

test('sharing only one generic keyword is not a match', () => {
	const idx = build(corpus);
	const res = idx.search({ title: 'מקרר רועש מאוד בלילה ובעיה בחשמל בבית', snippet: '' }, { minScore: 0.42 });
	assert.ok(!res.some(r => r.id === '1' || r.id === '5'));
});

test('unrelated query returns nothing', () => {
	const idx = build(corpus);
	assert.deepStrictEqual(idx.search({ title: 'quantum chromodynamics lecture notes' }), []);
});

test('related-but-different problem lands in the related tier, not duplicate', () => {
	const idx = build(corpus);
	const [top] = idx.search({ title: 'האינטרנט בסיבים איטי בשעות הערב', snippet: '' }, { minScore: 0.2 });
	assert.strictEqual(top.id, '5');
	assert.notStrictEqual(classify(top.score), 'duplicate');
});

test('remove() keeps document frequencies consistent', () => {
	const idx = build(corpus);
	const before = idx.size;
	idx.remove(3);
	idx.remove(3);
	assert.strictEqual(idx.size, before - 1);
	assert.ok(!idx.search({ title: 'Reset router admin password' }).some(r => r.id === '3'));
});

test('exclude and allow filters are honoured', () => {
	const idx = build(corpus.map(d => ({ ...d, meta: { cid: d.id === 1 ? 7 : 1 } })));
	const q = { title: 'איך להגדיר נתב ביתי לסיבים?', snippet: '' };
	assert.ok(!idx.search(q, { minScore: 0.2, exclude: new Set(['1']) }).some(r => r.id === '1'));
	assert.ok(!idx.search(q, { minScore: 0.2, allow: m => m.cid !== 7 }).some(r => r.id === '1'));
});

test('Hebrew morphological variants of the same phrase are suggested (infinitive vs noun)', () => {
	const idx = build([
		{ id: 1, title: 'בנייה מחדש', snippet: '' },
		{ id: 2, title: 'המלצה על מקרר חדש למטבח קטן', snippet: '' },
		{ id: 3, title: 'איך מתקינים תוכנה במחשב', snippet: '' },
		{ id: 4, title: 'ארוחת ערב מחדש', snippet: '' },
		...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, title: `נושא כללי ${i} על טיולים בצפון`, snippet: '' })),
	]);
	const res = idx.search({ title: 'לבנות מחדש', snippet: '' }, { minScore: 0.28 });
	assert.strictEqual(res[0].id, '1');
	assert.notStrictEqual(classify(res[0].score), 'weak');
	assert.ok(!res.some(r => r.id === '4'), 'sharing only "again" must not match');
});

/* ------------------------------------------------ broader matching */

const { convertLayout, setSynonyms } = require('../lib/similarity');

const wide = [
	{ id: 1, title: 'איך מתקינים תוכנה במחשב', snippet: '' },
	{ id: 2, title: 'בעיה בחיבור לאינטרנט בנתב', snippet: '' },
	{ id: 3, title: 'המלצה על מקרר חדש למטבח קטן', snippet: '' },
	{ id: 4, title: 'איך מגדירים נתב ביתי לחיבור סיבים', snippet: '' },
	{ id: 5, title: 'Best way to learn guitar chords quickly', snippet: '' },
	...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, title: `נושא כללי ${i} על טיולים בצפון`, snippet: '' })),
];

test('typos in a long word are corrected', () => {
	const idx = build(wide);
	const [top] = idx.search({ title: 'איך מתקינים תוכנא במחשב' }, { minScore: 0.3 });
	assert.strictEqual(top.id, '1');
	assert.ok(classify(top.score) !== 'weak');
});

test('synonyms connect differently worded questions', () => {
	const idx = build(wide);
	const [top] = idx.search({ title: 'תקלה ברשת בראוטר' }, { minScore: 0.3 });
	assert.strictEqual(top.id, '2');
});

test('plural / possessive forms match', () => {
	const idx = build(wide);
	const [top] = idx.search({ title: 'ההמלצות למקררים חדשים למטבחים' }, { minScore: 0.3 });
	assert.strictEqual(top.id, '3');
});

test('a topic typed with the wrong keyboard layout is still found (both directions)', () => {
	const idx = build(wide);
	const slipped = convertLayout('איך מגדירים נתב ביתי לחיבור סיבים');
	assert.ok(/^[a-z ,.;]+$/.test(slipped), `got ${slipped}`);
	assert.strictEqual(idx.search({ title: slipped }, { minScore: 0.3 })[0].id, '4');
	const he = convertLayout('best way to learn guitar chords');
	assert.ok(/[א-ת]/.test(he));
	assert.strictEqual(idx.search({ title: he }, { minScore: 0.3 })[0].id, '5');
	assert.strictEqual(convertLayout('mixed שפות here'), '');
});

test('admin-defined synonyms are applied', () => {
	setSynonyms('מקפיא, מקרר');
	try {
		const idx = build(wide);
		assert.strictEqual(idx.search({ title: 'המלצה על מקפיא חדש למטבח קטן' }, { minScore: 0.3 })[0].id, '3');
	} finally {
		setSynonyms('');
	}
});

test('broader matching does not match nonsense', () => {
	const idx = build(wide);
	const noise = [
		'בעיה בבישול עוגת שוקולד',         // shares only a synonym-group word with topic 2
		'תוכנית טלוויזיה חדשה בערב',        // looks a bit like "תוכנה" but is a different word
		'מחירון ביטוח רכב לשנה הבאה',
		'how to bake sourdough bread',
		'נתב',                                // single generic word is allowed but must never reach duplicate level for a different topic
	];
	for (const title of noise.slice(0, 4)) {
		const res = idx.search({ title }, { minScore: 0.36 });
		assert.deepStrictEqual(res.map(r => r.id), [], `"${title}" should match nothing, got ${JSON.stringify(res.map(r => [r.id, r.score.toFixed(2)]))}`);
	}
	// short words are never "typo-corrected" into other words
	assert.deepStrictEqual(idx.search({ title: 'גיטרה צבעים' }, { minScore: 0.36 }), []);
});

test('regression: "לנסות אמוג\'י" finds "נסיון לאמוג\'י" (noun vs infinitive, geresh)', () => {
	const idx = build([
		{ id: 1, title: "נסיון לאמוג'י", snippet: '' },
		{ id: 2, title: 'ארוחת ערב מחדש', snippet: '' },
		...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, title: `נושא כללי ${i} על טיולים בצפון`, snippet: '' })),
	]);
	for (const q of ["לנסות אמוג'י", 'לנסות אמוגי', "ניסיון אמוג'י"]) {
		const res = idx.search({ title: q }, { minScore: 0.36 });
		assert.strictEqual(res[0] && res[0].id, '1', `"${q}" should find the topic`);
	}
	assert.deepStrictEqual(idx.search({ title: 'לנסות מחדש' }, { minScore: 0.36 }).map(r => r.id), [], 'the shared word "מחדש" alone is not a match');
});

test('typical forum paraphrases are all suggested (at least as related)', () => {
	const pairs = [
		['איך מוסיפים אימוג\'י', 'הוספת אמוג\'י לפוסט'],
		['לא מצליח להתחבר לחשבון', 'בעיה בהתחברות לחשבון'],
		['מחיקת פוסט', 'איך למחוק פוסט'],
		['שינוי סיסמה', 'איך משנים סיסמא'],
		['האתר איטי', 'האתר נטען לאט'],
		['ליצור קבוצה חדשה', 'יצירת קבוצה'],
		['העלאת תמונה לפרופיל', 'איך מעלים תמונת פרופיל'],
		['לנסות אמוג\'י', 'נסיון לאמוג\'י'],
		['cant login to account', 'login problem with my account'],
	];
	const filler = Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, title: `נושא כללי ${i} על טיולים בצפון ומסעדות`, snippet: '' }));
	for (const [q, t] of pairs) {
		const idx = build([{ id: 1, title: t, snippet: '' }, ...filler]);
		const hit = idx.search({ title: q }, { minScore: 0.2 }).find(r => r.id === '1');
		assert.ok(hit && classify(hit.score) !== 'weak', `"${q}" should find "${t}" (score ${hit && hit.score.toFixed(2)})`);
	}
});
