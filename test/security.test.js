'use strict';

const test = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
const secrets = require('../lib/secrets');
const settings = require('../lib/settings');
const C = require('../lib/controllers');

test.beforeEach(() => helpers.install({ admins: [1] }));
test.afterEach(() => helpers.uninstall());

test('API key is stored encrypted and round-trips', async () => {
	const { db } = helpers.install({ admins: [1] });
	await secrets.setKey('gemini', 'AIza-super-secret-key');
	const raw = JSON.stringify(Array.from(db.objects.entries()));
	assert.ok(!raw.includes('AIza-super-secret-key'), 'plaintext key must never be in the database');
	assert.strictEqual(await secrets.getKey('gemini'), 'AIza-super-secret-key');
	assert.strictEqual(await secrets.hasKey('gemini'), true);
});

test('a changed forum secret makes stored keys unreadable instead of throwing', async () => {
	helpers.install({ admins: [1] });
	await secrets.setKey('gemini', 'k1');
	require('../lib/nbb').setOverride('nconf', { get: () => 'another-secret' });
	secrets._resetCache();
	assert.strictEqual(await secrets.getKey('gemini'), null);
});

test('tampered ciphertext is rejected', async () => {
	const blob = secrets._encrypt('hello');
	const parts = blob.split(':');
	parts[3] = Buffer.from('evil').toString('base64');
	assert.throws(() => secrets._decrypt(parts.join(':')));
});

test('keys can be replaced and deleted', async () => {
	await secrets.setKey('gemini', 'one');
	await secrets.setKey('gemini', 'two');
	assert.strictEqual(await secrets.getKey('gemini'), 'two');
	await secrets.deleteKey('gemini');
	assert.strictEqual(await secrets.hasKey('gemini'), false);
	await assert.rejects(() => secrets.setKey('gemini', '   '));
});

test('config endpoint never returns key material', async () => {
	await secrets.setKey('gemini', 'AIza-leak-check');
	const cfg = await C.getConfig({ uid: 1 });
	assert.ok(!JSON.stringify(cfg).includes('AIza-leak-check'));
	assert.strictEqual(cfg.keyState.gemini, true);
	assert.strictEqual(cfg.keyState.ollama, null);
});

test('putConfig cannot be used to set an API key', async () => {
	await C.putConfig({ uid: 1, body: { apiKey: 'sneaky', aiProvider: 'gemini' } });
	assert.strictEqual(await secrets.hasKey('gemini'), false);
});

test('admin routes reject non-admins and anonymous users', async () => {
	for (const uid of [0, 2]) {
		await assert.rejects(() => C.getConfig({ uid }), e => e.status === (uid ? 403 : 401));
		await assert.rejects(() => C.putKey({ uid, params: { provider: 'gemini' }, body: { apiKey: 'x' } }), e => e.status === (uid ? 403 : 401));
	}
});

test('putKey refuses providers that do not use keys', async () => {
	await assert.rejects(() => C.putKey({ uid: 1, params: { provider: 'ollama' }, body: { apiKey: 'x' } }), e => e.status === 400);
});

test('AI cannot be enabled without explicit consent', async () => {
	const s = await settings.update({ aiProvider: 'gemini', aiEnabled: true }, 1);
	assert.strictEqual(s.aiEnabled, false);
	const s2 = await settings.update({ aiConsent: true, aiEnabled: true }, 1);
	assert.strictEqual(s2.aiEnabled, true);
	assert.strictEqual(s2.aiConsentBy, 1);
	assert.ok(s2.aiConsentAt > 0);
	const s3 = await settings.update({ aiConsent: false }, 1);
	assert.strictEqual(s3.aiEnabled, false, 'withdrawing consent switches AI off');
});

test('deleting the key switches AI off for key-based providers', async () => {
	await secrets.setKey('gemini', 'k');
	await settings.update({ aiProvider: 'gemini', aiConsent: true, aiEnabled: true }, 1);
	await C.deleteKey({ uid: 1, params: { provider: 'gemini' } });
	assert.strictEqual((await settings.get()).aiEnabled, false);
});

test('provider test results never echo the key', async () => {
	await secrets.setKey('gemini', 'AIza-echo-check');
	const realFetch = global.fetch;
	global.fetch = async () => ({ ok: false, status: 400, statusText: 'Bad', text: async () => JSON.stringify({ error: { message: 'API key AIza-echo-check not valid' } }) });
	try {
		const res = await C.testProvider({ uid: 1, params: { provider: 'gemini' }, body: {} });
		assert.strictEqual(res.ok, false);
		assert.ok(!res.message.includes('AIza-echo-check'));
	} finally {
		global.fetch = realFetch;
	}
});

test('settings are clamped and sanitised', async () => {
	const s = await settings.update({ maxSuggestions: 999, suggestDuplicateThreshold: 5, aiOllamaUrl: 'javascript:alert(1)', superviseGroups: 'a, b' }, 1);
	assert.strictEqual(s.maxSuggestions, 10);
	assert.strictEqual(s.suggestDuplicateThreshold, 1);
	assert.ok(s.aiOllamaUrl.startsWith('http'));
	assert.deepStrictEqual(s.superviseGroups, ['a', 'b']);
});
