'use strict';

/**
 * In-memory stand-ins for the NodeBB internals the plugin uses, so every test
 * runs locally with no NodeBB install, no network and no CI.
 */

const nbb = require('../lib/nbb');

function makeDb() {
	const objects = new Map();
	const zsets = new Map();
	const db = {
		objects,
		zsets,
		async getObject(key) { return objects.has(key) ? { ...objects.get(key) } : null; },
		async getObjects(keys) { return keys.map(k => (objects.has(k) ? { ...objects.get(k) } : null)); },
		async setObject(key, data) { objects.set(key, { ...(objects.get(key) || {}), ...stringifyValues(data) }); },
		async setObjectField(key, field, value) { objects.set(key, { ...(objects.get(key) || {}), [field]: value }); },
		async getObjectField(key, field) { const o = objects.get(key); return o && field in o ? o[field] : null; },
		async deleteObjectField(key, field) { const o = objects.get(key); if (o) { delete o[field]; } },
		async exists(key) { return objects.has(key) || zsets.has(key); },
		async delete(key) { objects.delete(key); zsets.delete(key); },
		async sortedSetAdd(key, score, value) {
			const z = zsets.get(key) || new Map();
			z.set(String(value), score);
			zsets.set(key, z);
		},
		async sortedSetRemove(key, value) { const z = zsets.get(key); if (z) { z.delete(String(value)); } },
		async sortedSetCard(key) { return (zsets.get(key) || new Map()).size; },
		async getSortedSetRevRange(key, start, stop) {
			const z = zsets.get(key) || new Map();
			const sorted = Array.from(z.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]);
			return sorted.slice(start, stop < 0 ? undefined : stop + 1);
		},
	};
	return db;
}

// NodeBB's db layer stores everything as strings
function stringifyValues(data) {
	const out = {};
	Object.keys(data).forEach((k) => { out[k] = typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : String(data[k]); });
	return out;
}

/**
 * @param {object} world { topics: {tid: {...}}, posts: {pid: {content}}, admins: [uid], groups: {name: [uid]}, cats: {cid: name}, hiddenCids: [] }
 */
function install(world = {}) {
	const db = makeDb();
	const w = {
		topics: {}, posts: {}, admins: [], groups: {}, cats: { 1: 'General', 2: 'Support' }, hiddenCids: [], ...world,
	};
	const notificationsSent = [];

	nbb.setOverride('./src/database', db);
	nbb.setOverride('nconf', { get: key => (key === 'secret' ? 'test-forum-secret' : undefined) });
	nbb.setOverride('./src/user', {
		isAdministrator: async uid => w.admins.includes(Number(uid)),
		getUsersFields: async uids => uids.map(uid => ({ uid, username: `user${uid}` })),
	});
	nbb.setOverride('./src/groups', {
		isMemberOfGroups: async (uid, names) => names.map(n => (w.groups[n] || []).includes(Number(uid))),
		getMembers: async name => (name === 'administrators' ? w.admins : (w.groups[name] || [])),
		getNonPrivilegeGroups: async () => Object.keys(w.groups).map(name => ({ name })),
	});
	nbb.setOverride('./src/topics', {
		getTopicsFields: async tids => tids.map(tid => (w.topics[tid] ? { tid, ...w.topics[tid] } : null)),
		merge: async (tids, uid, opts) => { w.merged = { tids, uid, opts }; },
	});
	nbb.setOverride('./src/posts', {
		getPostsFields: async pids => pids.map(pid => (w.posts[pid] ? { pid, ...w.posts[pid] } : { pid, content: '' })),
		getPostFields: async pid => w.posts[pid] || null,
	});
	nbb.setOverride('./src/privileges', {
		categories: { filterCids: async (priv, cids) => cids.filter(c => !w.hiddenCids.includes(Number(c))) },
	});
	nbb.setOverride('./src/categories', {
		getCategoriesFields: async cids => cids.map(cid => ({ cid, name: w.cats[cid], slug: `c${cid}` })),
	});
	nbb.setOverride('./src/notifications', {
		create: async data => ({ ...data }),
		push: async (notif, uids) => { notificationsSent.push({ notif, uids }); },
	});

	// the topic list NodeBB exposes through the `topics:tid` sorted set; `notYet` topics exist but are not listed yet
	Object.keys(w.topics).forEach((tid) => {
		if (w.topics[tid] && !w.topics[tid].notYet) {
			db.zsets.set('topics:tid', (db.zsets.get('topics:tid') || new Map()).set(String(tid), w.topics[tid].timestamp));
		}
	});

	// reset every module-level cache
	require('../lib/settings')._reset();
	require('../lib/secrets')._resetCache();
	require('../lib/indexer')._reset();

	return { db, world: w, notificationsSent };
}

function uninstall() {
	nbb.clearOverrides();
}

module.exports = { install, uninstall, makeDb };
