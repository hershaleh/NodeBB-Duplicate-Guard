'use strict';

/**
 * Keeps an in-memory SimilarityIndex of recent topics (title + short excerpt of
 * the main post). Built lazily on first use and kept up to date through the
 * topic hooks, so suggestion requests never hit the database for scoring.
 */

const nbb = require('./nbb');
const { SimilarityIndex } = require('./similarity');
const settings = require('./settings');

const BATCH = 200;

let index = new SimilarityIndex();
let building = null;

function plainExcerpt(content, max = 400) {
	return String(content || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[#>*_`~|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

const Indexer = { plainExcerpt };

Indexer.getIndex = () => index;

async function loadBatch(tids) {
	const topics = nbb('./src/topics');
	const posts = nbb('./src/posts');
	const fields = await topics.getTopicsFields(tids, ['tid', 'title', 'cid', 'slug', 'timestamp', 'mainPid', 'deleted', 'scheduled']);
	const live = fields.filter(t => t && t.tid && !t.deleted && !t.scheduled);
	const mains = await posts.getPostsFields(live.map(t => t.mainPid), ['pid', 'content']);
	live.forEach((t, i) => {
		const snippet = plainExcerpt(mains[i] && mains[i].content);
		index.add({
			id: t.tid,
			title: t.title,
			snippet,
			meta: { cid: t.cid, slug: t.slug, timestamp: t.timestamp, mainPid: t.mainPid, excerpt: snippet.slice(0, 160) },
		});
	});
}

Indexer.build = async () => {
	const db = nbb('./src/database');
	const { indexLimit } = await settings.get();
	const fresh = new SimilarityIndex();
	const previous = index;
	index = fresh;
	try {
		const tids = await db.getSortedSetRevRange('topics:tid', 0, indexLimit - 1);
		for (let i = 0; i < tids.length; i += BATCH) {
			// eslint-disable-next-line no-await-in-loop
			await loadBatch(tids.slice(i, i + BATCH));
		}
	} catch (err) {
		index = previous;
		throw err;
	}
};

Indexer.ensure = async () => {
	if (index.size) {
		return index;
	}
	if (!building) {
		building = Indexer.build().finally(() => { building = null; });
	}
	await building;
	return index;
};

Indexer.upsertTopic = async (tid) => {
	if (!index.size && !building) {
		return; // not built yet; the lazy build will pick it up
	}
	await loadBatch([tid]);
};

Indexer.removeTopic = (tid) => index.remove(tid);

Indexer._reset = () => { index = new SimilarityIndex(); building = null; };

module.exports = Indexer;
