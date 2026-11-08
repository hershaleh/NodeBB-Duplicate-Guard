'use strict';

const nbb = require('./nbb');
const settings = require('./settings');
const secrets = require('./secrets');
const providers = require('./providers');
const detector = require('./detector');
const indexer = require('./indexer');
const supervisors = require('./supervisors');
const suspects = require('./suspects');

const escapeHtml = str => String(str)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const C = {};

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
C.HttpError = HttpError;

const requireUser = (req) => {
	if (!req.uid) {
		throw new HttpError(401, '[[error:not-logged-in]]');
	}
};

const requireAdmin = async (req) => {
	requireUser(req);
	if (!(await nbb('./src/user').isAdministrator(req.uid))) {
		throw new HttpError(403, '[[error:no-privileges]]');
	}
};

const requireSupervisor = async (req) => {
	requireUser(req);
	if (!(await supervisors.isSupervisor(req.uid))) {
		throw new HttpError(403, '[[error:no-privileges]]');
	}
};

/* ---------------------------------------------------------------- suggest */

const hits = new Map();
function rateLimited(uid) {
	const now = Date.now();
	const recent = (hits.get(uid) || []).filter(t => now - t < 60000);
	recent.push(now);
	hits.set(uid, recent);
	if (hits.size > 5000) {
		hits.clear();
	}
	return recent.length > 40;
}

C.suggest = async (req) => {
	requireUser(req);
	const cfg = await settings.get();
	if (!cfg.enabled || !cfg.suggestionsEnabled) {
		return { enabled: false, items: [] };
	}
	if (rateLimited(req.uid)) {
		throw new HttpError(429, '[[error:too-many-requests]]');
	}
	const title = String(req.query.title || '').slice(0, 300).trim();
	const content = String(req.query.content || '').slice(0, 2000);
	if (title.length < 4) {
		return { enabled: true, items: [] };
	}
	const { items } = await detector.analyze({ title, content, uid: req.uid });
	// `indexed` helps diagnose an empty panel (0 means no topics were loaded into the index)
	return { enabled: true, items, indexed: indexer.getIndex().size };
};

/* ------------------------------------------------------- supervisor ("me") */

C.me = async (req) => {
	requireUser(req);
	const [cfg, isSupervisor] = await Promise.all([settings.get(), supervisors.isSupervisor(req.uid)]);
	if (!isSupervisor) {
		return { supervisor: false };
	}
	return {
		supervisor: true,
		areaEnabled: cfg.enabled && cfg.flagsAreaEnabled,
		notifications: await supervisors.getNotificationPref(req.uid),
		pending: await suspects.countPending(),
	};
};

C.setNotifications = async (req) => {
	await requireSupervisor(req);
	const enabled = req.body && (req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 1);
	return { notifications: await supervisors.setNotificationPref(req.uid, enabled) };
};

/* ---------------------------------------------------------------- suspects */

async function enrich(rows, uid) {
	if (!rows.length) {
		return [];
	}
	const topics = nbb('./src/topics');
	const categories = nbb('./src/categories');
	const privileges = nbb('./src/privileges');
	const user = nbb('./src/user');
	const posts = nbb('./src/posts');

	const tids = Array.from(new Set(rows.flatMap(r => [r.tid, r.ofTid])));
	const fields = await topics.getTopicsFields(tids, ['tid', 'title', 'slug', 'cid', 'uid', 'timestamp', 'mainPid', 'deleted']);
	const byTid = new Map(fields.filter(f => f && f.tid).map(f => [Number(f.tid), f]));
	const cids = Array.from(new Set(fields.filter(f => f && f.cid).map(f => f.cid)));
	const readable = new Set((await privileges.categories.filterCids('topics:read', cids, uid)).map(String));
	const cats = await categories.getCategoriesFields(cids, ['cid', 'name']);
	const catName = new Map(cats.map(c => [String(c.cid), c.name]));
	const authors = await user.getUsersFields(Array.from(new Set(fields.map(f => f && f.uid).filter(Boolean))), ['uid', 'username']);
	const authorName = new Map(authors.map(a => [String(a.uid), a.username]));

	const mainPids = rows.map(r => (byTid.get(r.tid) || {}).mainPid);
	const mains = await posts.getPostsFields(mainPids, ['pid', 'content']);

	const view = t => t && readable.has(String(t.cid)) ? {
		tid: Number(t.tid),
		title: t.title,
		slug: t.slug,
		cid: t.cid,
		category: catName.get(String(t.cid)) || '',
		author: authorName.get(String(t.uid)) || '',
		timestamp: t.timestamp,
		deleted: !!t.deleted,
	} : null;

	return rows.map((r, i) => ({
		...r,
		percent: Math.round(r.score * 100),
		topic: view(byTid.get(r.tid)),
		original: view(byTid.get(r.ofTid)),
		excerpt: indexer.plainExcerpt(mains[i] && mains[i].content, 220),
	})).filter(r => r.topic && r.original);
}

C.listSuspects = async (req) => {
	await requireSupervisor(req);
	const cfg = await settings.get();
	if (!(cfg.enabled && cfg.flagsAreaEnabled)) {
		return { areaEnabled: false, suspects: [], total: 0 };
	}
	const status = req.query.status === 'all' ? 'all' : 'pending';
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const perPage = 20;
	const { total, suspects: rows } = await suspects.list({ status, start: (page - 1) * perPage, stop: page * perPage - 1 });
	return {
		areaEnabled: true,
		total,
		page,
		pageCount: Math.max(1, Math.ceil(total / perPage)),
		suspects: await enrich(rows, req.uid),
	};
};

async function getPendingOr404(tid) {
	const row = await suspects.get(tid);
	if (!row) {
		throw new HttpError(404, '[[error:no-topic]]');
	}
	return row;
}

C.dismiss = async (req) => {
	await requireSupervisor(req);
	const tid = parseInt(req.params.tid, 10);
	await getPendingOr404(tid);
	await suspects.resolve(tid, 'dismissed', req.uid);
	return { tid, status: 'dismissed' };
};

C.confirm = async (req) => {
	await requireSupervisor(req);
	const tid = parseInt(req.params.tid, 10);
	const row = await getPendingOr404(tid);
	const merge = req.body && (req.body.merge === true || req.body.merge === 'true');
	if (merge) {
		try {
			await nbb('./src/topics').merge([row.ofTid, tid], req.uid, { mainTid: row.ofTid });
		} catch (err) {
			throw new HttpError(400, err.message);
		}
	}
	await suspects.resolve(tid, merge ? 'merged' : 'confirmed', req.uid);
	return { tid, status: merge ? 'merged' : 'confirmed' };
};

/* ------------------------------------------------------------------- admin */

const publicConfig = async () => {
	const cfg = await settings.get();
	const keyState = {};
	await Promise.all(providers.list().map(async (p) => {
		keyState[p.id] = p.requiresKey ? await secrets.hasKey(p.id) : null;
	}));
	let allGroups = [];
	try {
		const names = await nbb('./src/database').getSortedSetRange('groups:createtime', 0, -1);
		allGroups = names.filter(n => n && n !== 'administrators' && !n.includes(':privileges:') && !n.startsWith('cid:'));
	} catch (err) {
		console.warn('[duplicate-guard] could not list groups:', err.message);
	}
	return { settings: cfg, providers: providers.describe(), keyState, allGroups };
};

C.getConfig = async (req) => {
	await requireAdmin(req);
	return publicConfig();
};

C.putConfig = async (req) => {
	await requireAdmin(req);
	const patch = { ...(req.body || {}) };
	// consent/provider values are validated; the API key can never be set through this route
	delete patch.apiKey;
	if (patch.aiProvider && patch.aiProvider !== 'none' && !providers.get(patch.aiProvider)) {
		throw new HttpError(400, 'Unknown AI provider');
	}
	await settings.update(patch, req.uid);
	// index size may have changed
	indexer._reset();
	return publicConfig();
};

C.putKey = async (req) => {
	await requireAdmin(req);
	const provider = providers.get(req.params.provider);
	if (!provider || !provider.requiresKey) {
		throw new HttpError(400, 'This provider does not use an API key');
	}
	try {
		await secrets.setKey(provider.id, req.body && req.body.apiKey);
	} catch (err) {
		throw new HttpError(400, err.message);
	}
	return { provider: provider.id, hasKey: true };
};

C.deleteKey = async (req) => {
	await requireAdmin(req);
	const provider = providers.get(req.params.provider);
	if (!provider) {
		throw new HttpError(400, 'Unknown AI provider');
	}
	await secrets.deleteKey(provider.id);
	const cfg = await settings.get();
	if (cfg.aiProvider === provider.id && provider.requiresKey) {
		await settings.update({ aiEnabled: false }, req.uid);
	}
	return { provider: provider.id, hasKey: false };
};

function scrub(message, apiKey) {
	let out = String(message || 'Unknown error');
	if (apiKey) {
		out = out.split(apiKey).join('***');
	}
	return out;
}

async function contextFor(req, provider) {
	const cfg = await settings.get();
	const body = req.body || {};
	const apiKey = provider.requiresKey ? (body.apiKey ? String(body.apiKey).trim() : await secrets.getKey(provider.id)) : null;
	return {
		apiKey,
		model: body.model || cfg.aiModel || provider.defaultModel,
		baseUrl: body.baseUrl || cfg.aiOllamaUrl,
	};
}

C.testProvider = async (req) => {
	await requireAdmin(req);
	const provider = providers.get(req.params.provider);
	if (!provider) {
		throw new HttpError(400, 'Unknown AI provider');
	}
	const ctx = await contextFor(req, provider);
	if (provider.requiresKey && !ctx.apiKey) {
		return { ok: false, message: 'No API key saved for this provider' };
	}
	try {
		await provider.test(ctx);
		return { ok: true, message: 'Connection and key are valid' };
	} catch (err) {
		return { ok: false, message: scrub(err.message, ctx.apiKey) };
	}
};

C.models = async (req) => {
	await requireAdmin(req);
	const provider = providers.get(req.params.provider);
	if (!provider) {
		throw new HttpError(400, 'Unknown AI provider');
	}
	const ctx = await contextFor({ body: { baseUrl: req.query.baseUrl } }, provider);
	try {
		return { models: provider.listModels ? await provider.listModels(ctx) : provider.models, live: true };
	} catch (err) {
		return { models: provider.models || [], live: false, warning: scrub(err.message, ctx.apiKey) };
	}
};

/* ----------------------------------------------------------- notifications */

C.notifySupervisors = async (topicData, original, score) => {
	const notifications = nbb('./src/notifications');
	const uids = (await supervisors.getNotifiable()).filter(uid => uid !== Number(topicData.uid));
	if (!uids.length) {
		return;
	}
	const safeTitle = escapeHtml(topicData.title || '').replace(/,/g, '&#44;');
	const notif = await notifications.create({
		bodyShort: `[[duplicate-guard:notify.suspect, ${safeTitle}, ${Math.round(score * 100)}]]`,
		bodyLong: String(original && original.title ? original.title : ''),
		nid: `duplicateguard:suspect:${topicData.tid}`,
		path: '/flags#duplicates',
		from: topicData.uid,
	});
	if (notif) {
		await notifications.push(notif, uids);
	}
};

module.exports = C;
