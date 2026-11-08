'use strict';

const nbb = require('./nbb');
const settings = require('./settings');
const secrets = require('./secrets');
const providers = require('./providers');
const indexer = require('./indexer');
const { classify } = require('./similarity');

const Detector = {};

let lastAiWarn = 0;
function warnAi(err) {
	if (Date.now() - lastAiWarn > 60000) {
		lastAiWarn = Date.now();
		console.warn(`[duplicate-guard] AI provider failed, using local engine only: ${err.message}`);
	}
}

/** Builds the ctx a provider needs, or null when AI must not be used. */
Detector.getAiContext = async (cfg) => {
	if (!cfg.aiEnabled || !cfg.aiConsent || cfg.aiProvider === 'none') {
		return null;
	}
	const provider = providers.get(cfg.aiProvider);
	if (!provider) {
		return null;
	}
	const apiKey = provider.requiresKey ? await secrets.getKey(provider.id) : null;
	if (provider.requiresKey && !apiKey) {
		return null;
	}
	return { provider, ctx: { apiKey, model: cfg.aiModel || provider.defaultModel, baseUrl: cfg.aiOllamaUrl } };
};

async function readableOnly(results, uid) {
	if (!results.length) {
		return results;
	}
	const privileges = nbb('./src/privileges');
	const cids = Array.from(new Set(results.map(r => r.meta.cid)));
	const allowed = new Set((await privileges.categories.filterCids('topics:read', cids, uid)).map(String));
	return results.filter(r => allowed.has(String(r.meta.cid)));
}

/**
 * @returns {Promise<{items: Array, usedAi: boolean}>}
 *   items sorted by score, each { tid, title, slug, cid, category, timestamp, excerpt, score (0-100), tier, method }
 */
Detector.analyze = async ({ title, content, uid, excludeTid, limit, minTier = 'related' }) => {
	const cfg = await settings.get();
	const index = await indexer.ensure();
	const maxItems = limit || cfg.maxSuggestions;
	const thresholds = { duplicate: cfg.suggestDuplicateThreshold, related: cfg.suggestRelatedThreshold };

	const exclude = excludeTid ? new Set([String(excludeTid)]) : undefined;
	let results = index.search(
		{ title, snippet: indexer.plainExcerpt(content, 400) },
		{ limit: maxItems * 3, minScore: Math.max(0.2, thresholds.related - 0.1), exclude }
	);
	results = await readableOnly(results, uid);

	let usedAi = false;
	let verdicts = null;
	const ai = results.length ? await Detector.getAiContext(cfg) : null;
	if (ai) {
		try {
			const posts = nbb('./src/posts');
			const top = results.slice(0, 6);
			const mains = await posts.getPostsFields(top.map(r => r.meta.mainPid), ['pid', 'content']);
			const topics = nbb('./src/topics');
			const titles = await topics.getTopicsFields(top.map(r => r.id), ['tid', 'title']);
			const candidates = top.map((r, i) => ({
				id: r.id,
				title: titles[i] && titles[i].title,
				excerpt: indexer.plainExcerpt(mains[i] && mains[i].content, 300),
			}));
			const out = await ai.provider.judge(ai.ctx, { query: { title, content }, candidates });
			verdicts = new Map(out.map(v => [v.id, v.verdict]));
			usedAi = true;
		} catch (err) {
			warnAi(err);
		}
	}

	const scored = [];
	for (const r of results) {
		let score = r.score;
		let tier = classify(score, thresholds);
		let method = 'local';
		const verdict = verdicts && verdicts.get(r.id);
		if (verdict) {
			method = 'ai';
			if (verdict === 'duplicate') {
				score = Math.max(score, Math.max(thresholds.duplicate, 0.85));
				tier = 'duplicate';
			} else if (verdict === 'related') {
				score = Math.min(Math.max(score, thresholds.related), thresholds.duplicate - 0.01);
				tier = 'related';
			} else if (score < 0.999) {
				continue; // AI says the topics only share keywords
			}
		}
		if (tier === 'weak' || (minTier === 'duplicate' && tier !== 'duplicate')) {
			continue;
		}
		scored.push({ r, score, tier, method });
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, maxItems);
	if (!top.length) {
		return { items: [], usedAi };
	}

	const topics = nbb('./src/topics');
	const categories = nbb('./src/categories');
	const fields = await topics.getTopicsFields(top.map(s => s.r.id), ['tid', 'title', 'slug', 'cid', 'timestamp']);
	const cats = await categories.getCategoriesFields(Array.from(new Set(top.map(s => s.r.meta.cid))), ['cid', 'name', 'slug']);
	const catMap = new Map(cats.map(c => [String(c.cid), c]));
	const index2 = indexer.getIndex();
	const items = top.map((s, i) => {
		const doc = index2.docs.get(String(s.r.id));
		return {
			tid: Number(s.r.id),
			title: fields[i].title,
			slug: fields[i].slug,
			cid: fields[i].cid,
			category: (catMap.get(String(fields[i].cid)) || {}).name || '',
			timestamp: fields[i].timestamp,
			excerpt: doc ? (doc.meta.excerpt || '') : '',
			score: Math.round(s.score * 100),
			tier: s.tier,
			method: s.method,
			sharedTerms: s.r.sharedTerms.slice(0, 5),
		};
	});
	return { items, usedAi };
};

module.exports = Detector;
