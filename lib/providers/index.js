'use strict';

/**
 * AI provider registry. Providers implement:
 *
 *   {
 *     id, name, requiresKey: boolean, defaultModel, models: string[],
 *     dataNotice: string,                       // what is sent to the provider
 *     listModels(ctx) -> Promise<string[]>,     // optional, live list
 *     test(ctx) -> Promise<void>,               // throws on failure
 *     judge(ctx, { query, candidates }) -> Promise<Array<{id, verdict}>>
 *   }
 *
 * where ctx = { apiKey, model, baseUrl }. Third parties can add providers via
 * the `filter:duplicate-guard.providers` hook or `registry.register()`.
 */

const gemini = require('./gemini');
const ollama = require('./ollama');

const registry = new Map();

function register(provider) {
	if (!provider || !provider.id || typeof provider.judge !== 'function' || typeof provider.test !== 'function') {
		throw new Error('Invalid provider: needs id, test() and judge()');
	}
	registry.set(provider.id, provider);
}

register(gemini);
register(ollama);

module.exports = {
	register,
	get: id => registry.get(id) || null,
	list: () => Array.from(registry.values()),
	describe: () => Array.from(registry.values()).map(p => ({
		id: p.id,
		name: p.name,
		requiresKey: !!p.requiresKey,
		defaultModel: p.defaultModel,
		models: p.models || [],
		dataNotice: p.dataNotice,
	})),
};
