'use strict';

const nbb = require('./nbb');

const ALL = 'duplicateguard:suspects';
const PENDING = 'duplicateguard:suspects:pending';
const objKey = tid => `duplicateguard:suspect:${tid}`;

const Suspects = {};

Suspects.create = async ({ tid, ofTid, score, method }) => {
	const db = nbb('./src/database');
	if (await db.exists(objKey(tid))) {
		return null; // already tracked
	}
	const now = Date.now();
	const data = { tid, ofTid, score, method: method || 'local', status: 'pending', createdAt: now, resolvedBy: 0, resolvedAt: 0 };
	await Promise.all([
		db.setObject(objKey(tid), data),
		db.sortedSetAdd(ALL, now, tid),
		db.sortedSetAdd(PENDING, now, tid),
	]);
	return data;
};

Suspects.get = async (tid) => {
	const db = nbb('./src/database');
	const data = await db.getObject(objKey(tid));
	return data && data.tid ? normalize(data) : null;
};

function normalize(d) {
	return {
		tid: Number(d.tid),
		ofTid: Number(d.ofTid),
		score: Number(d.score),
		method: d.method,
		status: d.status,
		createdAt: Number(d.createdAt),
		resolvedBy: Number(d.resolvedBy) || 0,
		resolvedAt: Number(d.resolvedAt) || 0,
	};
}

/** status: 'pending' (default) or 'all'. Newest first. */
Suspects.list = async ({ status = 'pending', start = 0, stop = 19 } = {}) => {
	const db = nbb('./src/database');
	const set = status === 'pending' ? PENDING : ALL;
	const [tids, total] = await Promise.all([db.getSortedSetRevRange(set, start, stop), db.sortedSetCard(set)]);
	const rows = await db.getObjects(tids.map(objKey));
	return { total, suspects: rows.filter(r => r && r.tid).map(normalize) };
};

Suspects.countPending = () => nbb('./src/database').sortedSetCard(PENDING);

Suspects.resolve = async (tid, status, uid) => {
	const db = nbb('./src/database');
	const current = await Suspects.get(tid);
	if (!current) {
		throw new Error('[[error:no-topic]]');
	}
	await Promise.all([
		db.setObject(objKey(tid), { status, resolvedBy: uid, resolvedAt: Date.now() }),
		db.sortedSetRemove(PENDING, tid),
	]);
	return { ...current, status, resolvedBy: uid };
};

/** Used when a topic is purged: forget the suspicion entirely. */
Suspects.remove = async (tid) => {
	const db = nbb('./src/database');
	await Promise.all([db.delete(objKey(tid)), db.sortedSetRemove(ALL, tid), db.sortedSetRemove(PENDING, tid)]);
};

module.exports = Suspects;
