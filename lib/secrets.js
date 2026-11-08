'use strict';

/**
 * Server-side encrypted storage for AI provider API keys.
 *
 * Keys are encrypted with AES-256-GCM using a key derived (scrypt) from the
 * forum's own `secret` in config.json, and stored in the NodeBB database.
 * The decrypted key never leaves the server process and is never returned by
 * any API route (only a boolean "has key" flag is exposed).
 */

const crypto = require('crypto');
const nbb = require('./nbb');

const DB_KEY = 'duplicateguard:secrets';
const SALT = 'nodebb-plugin-duplicate-guard:v1';

let cachedKey = null;

function masterKey() {
	if (cachedKey) {
		return cachedKey;
	}
	const nconf = nbb('nconf');
	const secret = nconf.get('secret');
	if (!secret) {
		throw new Error('[[duplicate-guard:error.no-secret]]');
	}
	cachedKey = crypto.scryptSync(String(secret), SALT, 32);
	return cachedKey;
}

function encrypt(plain) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
	const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
	const [version, iv, tag, data] = String(blob).split(':');
	if (version !== 'v1' || !iv || !tag || !data) {
		throw new Error('Unsupported secret format');
	}
	const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
	decipher.setAuthTag(Buffer.from(tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const Secrets = {};

Secrets.setKey = async (providerId, apiKey) => {
	const db = nbb('./src/database');
	const key = String(apiKey || '').trim();
	if (!key) {
		throw new Error('[[duplicate-guard:error.empty-key]]');
	}
	await db.setObjectField(DB_KEY, providerId, encrypt(key));
};

Secrets.getKey = async (providerId) => {
	const db = nbb('./src/database');
	const blob = await db.getObjectField(DB_KEY, providerId);
	if (!blob) {
		return null;
	}
	try {
		return decrypt(blob);
	} catch (err) {
		// the forum secret changed or the value was corrupted: treat as absent
		return null;
	}
};

Secrets.hasKey = async (providerId) => {
	const db = nbb('./src/database');
	return !!(await db.getObjectField(DB_KEY, providerId));
};

Secrets.deleteKey = async (providerId) => {
	const db = nbb('./src/database');
	await db.deleteObjectField(DB_KEY, providerId);
};

Secrets._resetCache = () => { cachedKey = null; };
Secrets._encrypt = encrypt;
Secrets._decrypt = decrypt;

module.exports = Secrets;
