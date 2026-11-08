'use strict';

const nbb = require('./lib/nbb');
const settings = require('./lib/settings');
const indexer = require('./lib/indexer');
const detector = require('./lib/detector');
const suspects = require('./lib/suspects');
const providers = require('./lib/providers');
const C = require('./lib/controllers');

const Plugin = {};

// relative to /api/v3/plugins (clients call /plugins/duplicate-guard/...)
const BASE = '/duplicate-guard';

function wrap(handler) {
	return async (req, res) => {
		try {
			const payload = await handler(req);
			const helpers = nbb('./src/routes/helpers');
			return helpers.formatApiResponse(200, res, payload);
		} catch (err) {
			const helpers = nbb('./src/routes/helpers');
			const status = err instanceof C.HttpError ? err.status : 500;
			if (status === 500) {
				console.error('[duplicate-guard]', err);
				return helpers.formatApiResponse(500, res, new Error('[[error:invalid-data]]'));
			}
			return helpers.formatApiResponse(status, res, new Error(err.message));
		}
	};
}

Plugin.init = async ({ router, middleware }) => {
	const routeHelpers = nbb('./src/routes/helpers');
	// Admin page (ACP) -> renders templates/admin/plugins/duplicate-guard.tpl
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/duplicate-guard', async (req, res) => {
		res.render('admin/plugins/duplicate-guard', { title: 'Duplicate Guard' });
	});

	// Let other plugins register extra AI providers.
	const hooks = nbb('./src/plugins').hooks;
	const extra = await hooks.fire('filter:duplicate-guard.providers', { providers: [] });
	(extra.providers || []).forEach((p) => {
		try { providers.register(p); } catch (err) { console.warn('[duplicate-guard] ignoring provider:', err.message); }
	});
};

Plugin.addApiRoutes = async ({ router, middleware }) => {
	// The router is already mounted at /api/v3/plugins, so paths are relative to that.
	const routeHelpers = nbb('./src/routes/helpers');
	const auth = [middleware.ensureLoggedIn];
	const route = (verb, path, handler) => routeHelpers.setupApiRoute(router, verb, `${BASE}${path}`, auth, wrap(handler));

	route('get', '/suggest', C.suggest);
	route('get', '/me', C.me);
	route('put', '/me/notifications', C.setNotifications);
	route('get', '/suspects', C.listSuspects);
	route('post', '/suspects/:tid/dismiss', C.dismiss);
	route('post', '/suspects/:tid/confirm', C.confirm);

	route('get', '/admin/config', C.getConfig);
	route('put', '/admin/config', C.putConfig);
	route('put', '/admin/key/:provider', C.putKey);
	route('delete', '/admin/key/:provider', C.deleteKey);
	route('post', '/admin/test/:provider', C.testProvider);
	route('get', '/admin/models/:provider', C.models);
};

Plugin.addAdminMenu = async (header) => {
	header.plugins.push({
		route: '/plugins/duplicate-guard',
		icon: 'fa-clone',
		name: 'Duplicate Guard',
	});
	return header;
};

/* ------------------------------------------------------------ topic hooks */

Plugin.onTopicPost = async ({ topic }) => {
	try {
		const cfg = await settings.get();
		if (!cfg.enabled || !topic || !topic.tid) {
			return;
		}
		// Analyse BEFORE adding the new topic to the index, so it cannot match itself.
		const post = await nbb('./src/posts').getPostFields(topic.mainPid, ['content']);
		const { items } = await detector.analyze({
			title: topic.title,
			content: post && post.content,
			uid: Number(topic.uid),
			excludeTid: topic.tid,
			limit: 1,
			minTier: 'duplicate',
		});
		await indexer.upsertTopic(topic.tid);
		const best = items[0];
		if (!best || best.score / 100 < cfg.suspectThreshold) {
			return;
		}
		const created = await suspects.create({ tid: topic.tid, ofTid: best.tid, score: best.score / 100, method: best.method });
		if (created && cfg.flagsAreaEnabled) {
			await C.notifySupervisors(topic, best, best.score / 100);
		}
	} catch (err) {
		// Never let detection break topic creation.
		console.error('[duplicate-guard] failed to analyse new topic:', err);
	}
};

Plugin.onTopicRemoved = async ({ topic, tid }) => {
	const id = tid || (topic && topic.tid);
	if (id) {
		indexer.removeTopic(id);
	}
};

Plugin.onTopicRestored = async ({ topic }) => {
	if (topic && topic.tid) {
		await indexer.upsertTopic(topic.tid).catch(() => {});
	}
};

Plugin.onTopicMoved = Plugin.onTopicRestored;
Plugin.onTopicEdited = async ({ topic }) => Plugin.onTopicRestored({ topic });

module.exports = Plugin;
