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
