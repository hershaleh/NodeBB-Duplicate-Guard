'use strict';

const test = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
const settings = require('../lib/settings');
const secrets = require('../lib/secrets');
const supervisors = require('../lib/supervisors');
const suspects = require('../lib/suspects');
const detector = require('../lib/detector');
const providers = require('../lib/providers');
const C = require('../lib/controllers');
const Plugin = require('../library');

const NOW = Date.now();

// a forum with only a handful of topics has meaningless IDF, so fixtures include unrelated background topics
const filler = {};
const fillerPosts = {};
for (let i = 0; i < 25; i++) {
	filler[200 + i] = { title: `נושא כללי מספר ${i} על טיולים וקמפינג בצפון`, slug: `${200 + i}/f`, cid: 1, uid: 5, timestamp: NOW - 5000 - i, mainPid: 500 + i };
	fillerPosts[500 + i] = { content: '' };
}

function world(extra = {}) {
	return {
		admins: [1],
		groups: { 'forum-mods': [2, 3] },
		topics: {
			...filler,
			10: { title: 'איך מגדירים נתב ביתי לחיבור סיבים', slug: '10/router', cid: 1, uid: 5, timestamp: NOW - 1000, mainPid: 100 },
			11: { title: 'המלצה על מקרר חדש למטבח קטן', slug: '11/fridge', cid: 1, uid: 5, timestamp: NOW - 900, mainPid: 101 },
			12: { title: 'How do I reset my router password?', slug: '12/pw', cid: 2, uid: 5, timestamp: NOW - 800, mainPid: 102 },
			13: { title: 'איך להגדיר נתב ביתי לסיבים', slug: '13/new', cid: 1, uid: 6, timestamp: NOW, mainPid: 103, notYet: true },
		},
		posts: {
			...fillerPosts,
			100: { content: 'קניתי נתב חדש ואני לא מצליח להגדיר אותו' },
			101: { content: 'מחפש מקרר חסכוני' },
			102: { content: 'I forgot the admin password' },
			103: { content: 'קניתי נתב ולא מצליח' },
		},
		...extra,
	};
}

test.afterEach(() => helpers.uninstall());

/* ------------------------------------------------ permission vs preference */

test('permission and notification preference are independent', async () => {
	helpers.install(world());
	await settings.update({ superviseGroups: ['forum-mods'] }, 1);

	assert.strictEqual(await supervisors.isSupervisor(1), true, 'admin');
	assert.strictEqual(await supervisors.isSupervisor(2), true, 'group member');
	assert.strictEqual(await supervisors.isSupervisor(9), false, 'regular user');

	// turning notifications off keeps permission
	await supervisors.setNotificationPref(2, false);
	assert.strictEqual(await supervisors.isSupervisor(2), true);
	assert.strictEqual(await supervisors.getNotificationPref(2), false);

	// preference is personal: user 3 is unaffected, as are global settings
	assert.strictEqual(await supervisors.getNotificationPref(3), true);
	assert.strictEqual((await settings.get()).notificationsDefault, true);
	assert.deepStrictEqual(await supervisors.getNotifiable(), [1, 3]);

	await supervisors.setNotificationPref(2, true);
	assert.deepStrictEqual((await supervisors.getNotifiable()).sort(), [1, 2, 3]);
});

test('preference persists (stored in the database, not in the session)', async () => {
	const { db } = helpers.install(world());
	await supervisors.setNotificationPref(1, false);
	// simulate a fresh server process / new login: drop all in-memory caches
	settings._reset();
	assert.strictEqual(await supervisors.getNotificationPref(1), false);
	assert.strictEqual(db.objects.get('duplicateguard:user:1').notify, '0');
});

test('users cannot grant themselves permission or set preferences', async () => {
	helpers.install(world());
	await assert.rejects(() => supervisors.setNotificationPref(9, true));
	await assert.rejects(() => C.setNotifications({ uid: 9, body: { enabled: true } }), e => e.status === 403);
	await assert.rejects(() => C.putConfig({ uid: 2, body: { superviseGroups: ['everyone'] } }), e => e.status === 403);
});

test('the preference route only ever changes the caller\'s own preference', async () => {
	helpers.install(world());
	await C.setNotifications({ uid: 1, body: { enabled: false }, params: { uid: 3 }, query: { uid: 3 } });
	assert.strictEqual(await supervisors.getNotificationPref(1), false);
	assert.strictEqual(await supervisors.getNotificationPref(3), true);
});

/* ------------------------------------------------------------ flags area */

async function seedSuspect() {
	await suspects.create({ tid: 13, ofTid: 10, score: 0.9, method: 'local' });
}

test('supervisors still see pending suspects when notifications are off', async () => {
	helpers.install(world());
	await seedSuspect();
	await supervisors.setNotificationPref(1, false);
	const res = await C.listSuspects({ uid: 1, query: {} });
	assert.strictEqual(res.total, 1);
	assert.strictEqual(res.suspects[0].topic.tid, 13);
	assert.strictEqual(res.suspects[0].original.tid, 10);
	const me = await C.me({ uid: 1 });
	assert.deepStrictEqual([me.supervisor, me.areaEnabled, me.notifications, me.pending], [true, true, false, 1]);
});

test('non-supervisors get nothing from the flags area', async () => {
	helpers.install(world());
	await seedSuspect();
	await assert.rejects(() => C.listSuspects({ uid: 9, query: {} }), e => e.status === 403);
	assert.deepStrictEqual(await C.me({ uid: 9 }), { supervisor: false });
});

test('area switched off: UI data is empty and no notifications are sent', async () => {
	const { notificationsSent } = helpers.install(world());
	await settings.update({ flagsAreaEnabled: false }, 1);
	await seedSuspect();
	const res = await C.listSuspects({ uid: 1, query: {} });
	assert.deepStrictEqual([res.areaEnabled, res.suspects.length], [false, 0]);
	assert.strictEqual((await C.me({ uid: 1 })).areaEnabled, false);

	await Plugin.onTopicPost({ topic: { tid: 13, title: world().topics[13].title, uid: 6, mainPid: 103 } });
	assert.strictEqual(notificationsSent.length, 0);
});

test('suspects hidden from supervisors who cannot read the category', async () => {
	helpers.install(world({ hiddenCids: [2] }));
	await suspects.create({ tid: 13, ofTid: 12, score: 0.9 });
	assert.strictEqual((await C.listSuspects({ uid: 1, query: {} })).suspects.length, 0);
});

test('dismiss / confirm / merge workflow', async () => {
	const h = helpers.install(world());
	await seedSuspect();
	await C.dismiss({ uid: 1, params: { tid: '13' } });
	assert.strictEqual((await C.listSuspects({ uid: 1, query: {} })).total, 0);
	assert.strictEqual((await C.listSuspects({ uid: 1, query: { status: 'all' } })).suspects[0].status, 'dismissed');

	await suspects.remove(13);
	await seedSuspect();
	const res = await C.confirm({ uid: 1, params: { tid: '13' }, body: { merge: true } });
	assert.strictEqual(res.status, 'merged');
	assert.deepStrictEqual(h.world.merged.opts, { mainTid: 10 });
	await assert.rejects(() => C.dismiss({ uid: 1, params: { tid: '999' } }), e => e.status === 404);
});

/* ------------------------------------------------------------- detection */

test('new topic: duplicate is queued and only notifiable supervisors are notified', async () => {
	const h = helpers.install(world());
	// the fixture forum has only a handful of topics, so IDF is weak: use an explicit, lower threshold
	await settings.update({ superviseGroups: ['forum-mods'], suspectThreshold: 0.5 }, 1);
	await supervisors.setNotificationPref(2, false);

	await Plugin.onTopicPost({ topic: { tid: 13, title: h.world.topics[13].title, uid: 6, mainPid: 103 } });

	const row = await suspects.get(13);
	assert.ok(row, 'suspect recorded');
	assert.strictEqual(row.ofTid, 10);
	assert.strictEqual(row.status, 'pending');
	assert.strictEqual(h.notificationsSent.length, 1);
	assert.deepStrictEqual(h.notificationsSent[0].uids.sort(), [1, 3]);
	assert.ok(h.notificationsSent[0].notif.bodyShort.startsWith('[[duplicate-guard:notify.suspect,'));
});

test('new topic: unrelated topic is never queued; detection failure never throws', async () => {
	const h = helpers.install(world());
	h.world.topics[20] = { title: 'quantum lecture notes', slug: '20/q', cid: 1, uid: 6, timestamp: NOW, mainPid: 110 };
	h.world.posts[110] = { content: 'physics' };
	await Plugin.onTopicPost({ topic: { tid: 20, title: 'quantum lecture notes', uid: 6, mainPid: 110 } });
	assert.strictEqual(await suspects.get(20), null);

	require('../lib/nbb').setOverride('./src/posts', { getPostsFields: async () => { throw new Error('db down'); }, getPostFields: async () => { throw new Error('db down'); } });
	await Plugin.onTopicPost({ topic: { tid: 21, title: 'x', uid: 6, mainPid: 1 } }); // must not throw
});

test('works with no API key and no AI: local engine returns ranked tiers', async () => {
	helpers.install(world());
	const { items, usedAi } = await detector.analyze({ title: 'איך להגדיר נתב ביתי לסיבים', content: 'נתב חדש', uid: 9, excludeTid: 13 });
	assert.strictEqual(usedAi, false);
	assert.strictEqual(items[0].tid, 10);
	assert.strictEqual(items[0].tier, 'duplicate');
	assert.ok(items[0].category && items[0].timestamp && items[0].slug && items[0].score > 0);
	assert.ok(!items.some(i => i.tid === 11), 'fridge topic must not be suggested');
	assert.ok(items.length <= 5);
});

test('suggestions respect category read privileges', async () => {
	helpers.install(world({ hiddenCids: [2] }));
	const { items } = await detector.analyze({ title: 'Reset router admin password', content: '', uid: 9 });
	assert.ok(!items.some(i => i.tid === 12));
});

test('AI path: verdicts adjust tiers; AI failure falls back to local', async () => {
	helpers.install(world());
	await secrets.setKey('gemini', 'k');
	await settings.update({ aiProvider: 'gemini', aiConsent: true, aiEnabled: true }, 1);

	const gemini = providers.get('gemini');
	const realJudge = gemini.judge;
	try {
		gemini.judge = async (ctx, { candidates }) => {
			assert.strictEqual(ctx.apiKey, 'k');
			return candidates.map(c => ({ id: String(c.id), verdict: String(c.id) === '10' ? 'unrelated' : 'duplicate' }));
		};
		let res = await detector.analyze({ title: 'איך להגדיר נתב ביתי לסיבים', content: '', uid: 9, excludeTid: 13 });
		assert.strictEqual(res.usedAi, true);
		assert.ok(!res.items.some(i => i.tid === 10), 'AI said unrelated');

		gemini.judge = async () => { throw new Error('quota'); };
		res = await detector.analyze({ title: 'איך להגדיר נתב ביתי לסיבים', content: '', uid: 9, excludeTid: 13 });
		assert.strictEqual(res.usedAi, false);
		assert.strictEqual(res.items[0].tid, 10, 'local result survives AI outage');
	} finally {
		gemini.judge = realJudge;
	}
});

test('no content is sent to AI without consent, even when a key exists', async () => {
	helpers.install(world());
	await secrets.setKey('gemini', 'k');
	await settings.update({ aiProvider: 'gemini', aiEnabled: true }, 1); // consent missing
	const gemini = providers.get('gemini');
	const realJudge = gemini.judge;
	let called = false;
	gemini.judge = async () => { called = true; return []; };
	try {
		await detector.analyze({ title: 'איך להגדיר נתב ביתי לסיבים', content: '', uid: 9 });
		assert.strictEqual(called, false);
	} finally { gemini.judge = realJudge; }
});

test('suggest endpoint: short titles, disabled setting and rate limit', async () => {
	helpers.install(world());
	assert.deepStrictEqual((await C.suggest({ uid: 9, query: { title: 'hi' } })).items, []);
	await assert.rejects(() => C.suggest({ uid: 0, query: { title: 'long enough title' } }), e => e.status === 401);
	await settings.update({ suggestionsEnabled: false }, 1);
	assert.strictEqual((await C.suggest({ uid: 9, query: { title: 'long enough title' } })).enabled, false);
	await settings.update({ suggestionsEnabled: true }, 1);
	let limited = 0;
	for (let i = 0; i < 45; i++) {
		try { await C.suggest({ uid: 77, query: { title: 'long enough title' } }); } catch (e) { limited += e.status === 429 ? 1 : 0; }
	}
	assert.ok(limited >= 1);
});
