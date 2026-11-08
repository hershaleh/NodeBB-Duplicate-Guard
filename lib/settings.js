'use strict';

const nbb = require('./nbb');
const { DEFAULT_THRESHOLDS } = require('./similarity');

const DB_KEY = 'duplicateguard:settings';

const DEFAULTS = {
	enabled: true,
	suggestionsEnabled: true,
	flagsAreaEnabled: true, // show the supervision area inside Flags
	maxSuggestions: 5,
	suggestDuplicateThreshold: DEFAULT_THRESHOLDS.duplicate,
	suggestRelatedThreshold: DEFAULT_THRESHOLDS.related,
	suspectThreshold: 0.7, // score at which a newly created topic is queued for supervisors
	indexLimit: 5000,
	superviseGroups: [], // admins are always allowed
	notificationsDefault: true, // default for supervisors that never chose a preference
	aiProvider: 'none', // 'none' | provider id
	aiModel: '',
	aiOllamaUrl: 'http://127.0.0.1:11434',
	aiConsent: false,
	aiConsentBy: 0,
	aiConsentAt: 0,
	aiEnabled: false, // master switch: false = local engine only
};

function toBool(v, fallback) {
	if (v === undefined || v === null || v === '') {
		return fallback;
	}
	return v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
}

function toNum(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, n));
}

function parseGroups(v) {
	if (Array.isArray(v)) {
		return v.map(String).filter(Boolean);
	}
	if (typeof v === 'string' && v.trim()) {
		try {
			const parsed = JSON.parse(v);
			if (Array.isArray(parsed)) {
				return parsed.map(String).filter(Boolean);
			}
		} catch (e) { /* fall through to comma separated */ }
		return v.split(',').map(s => s.trim()).filter(Boolean);
	}
	return [];
}

function sanitize(raw) {
	const r = raw || {};
	const out = {
		enabled: toBool(r.enabled, DEFAULTS.enabled),
		suggestionsEnabled: toBool(r.suggestionsEnabled, DEFAULTS.suggestionsEnabled),
		flagsAreaEnabled: toBool(r.flagsAreaEnabled, DEFAULTS.flagsAreaEnabled),
		maxSuggestions: Math.round(toNum(r.maxSuggestions, DEFAULTS.maxSuggestions, 1, 10)),
		suggestDuplicateThreshold: toNum(r.suggestDuplicateThreshold, DEFAULTS.suggestDuplicateThreshold, 0.4, 1),
		suggestRelatedThreshold: toNum(r.suggestRelatedThreshold, DEFAULTS.suggestRelatedThreshold, 0.2, 0.95),
		suspectThreshold: toNum(r.suspectThreshold, DEFAULTS.suspectThreshold, 0.4, 1),
		indexLimit: Math.round(toNum(r.indexLimit, DEFAULTS.indexLimit, 100, 50000)),
		superviseGroups: parseGroups(r.superviseGroups),
		notificationsDefault: toBool(r.notificationsDefault, DEFAULTS.notificationsDefault),
		aiProvider: String(r.aiProvider || DEFAULTS.aiProvider),
		aiModel: String(r.aiModel || '').slice(0, 120),
		aiOllamaUrl: String(r.aiOllamaUrl || DEFAULTS.aiOllamaUrl).slice(0, 300),
		aiConsent: toBool(r.aiConsent, false),
		aiConsentBy: Number(r.aiConsentBy) || 0,
		aiConsentAt: Number(r.aiConsentAt) || 0,
		aiEnabled: toBool(r.aiEnabled, false),
	};
	if (out.suggestRelatedThreshold >= out.suggestDuplicateThreshold) {
		out.suggestRelatedThreshold = Math.max(0.2, out.suggestDuplicateThreshold - 0.05);
	}
	if (!/^https?:\/\//i.test(out.aiOllamaUrl)) {
		out.aiOllamaUrl = DEFAULTS.aiOllamaUrl;
	}
	return out;
}

let cache = null;

const Settings = {
	DEFAULTS,
	sanitize,
};

Settings.get = async () => {
	if (cache) {
		return cache;
	}
	const db = nbb('./src/database');
	cache = sanitize(await db.getObject(DB_KEY));
	return cache;
};

/**
 * Persists a partial update. The consent flag is stamped with who gave it and
 * when; withdrawing consent also switches AI off.
 */
Settings.update = async (patch, uid) => {
	const db = nbb('./src/database');
	const current = await Settings.get();
	const merged = { ...current, ...patch };
	const next = sanitize(merged);

	if (patch.aiConsent !== undefined) {
		if (next.aiConsent && !current.aiConsent) {
			next.aiConsentBy = uid;
			next.aiConsentAt = Date.now();
		} else if (!next.aiConsent) {
			next.aiConsentBy = 0;
			next.aiConsentAt = 0;
		}
	}
	// AI can only be active with explicit consent and a chosen provider
	if (!next.aiConsent || next.aiProvider === 'none') {
		next.aiEnabled = false;
	}
	const toStore = { ...next, superviseGroups: JSON.stringify(next.superviseGroups) };
	await db.setObject(DB_KEY, toStore);
	cache = next;
	return next;
};

Settings._reset = () => { cache = null; };

module.exports = Settings;
