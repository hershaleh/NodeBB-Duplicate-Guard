'use strict';

const { buildPrompt, parseVerdicts, httpJson } = require('./prompt');

function base(ctx) {
	return String(ctx.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

async function chat(ctx, text) {
	const body = await httpJson(`${base(ctx)}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: ctx.model || provider.defaultModel,
			stream: false,
			format: 'json',
			options: { temperature: 0 },
			messages: [{ role: 'user', content: text }],
		}),
	}, 60000);
	const out = body && body.message && body.message.content;
	if (!out) {
		throw new Error('Ollama returned an empty response');
	}
	return out;
}

const provider = {
	id: 'ollama',
	name: 'Ollama (local models)',
	requiresKey: false,
	defaultModel: 'llama3.1',
	models: ['llama3.1', 'qwen2.5', 'gemma2'],
	dataNotice: 'Topic text is sent only to the Ollama server address you configured. If that server runs on your own infrastructure, nothing leaves it.',

	async listModels(ctx) {
		const body = await httpJson(`${base(ctx)}/api/tags`, {}, 8000);
		const live = ((body && body.models) || []).map(m => m.name).filter(Boolean);
		return live.length ? live : provider.models;
	},

	async test(ctx) {
		const names = await provider.listModels(ctx);
		const wanted = ctx.model || provider.defaultModel;
		const has = names.some(n => n === wanted || n.split(':')[0] === wanted);
		if (!has) {
			throw new Error(`Model "${wanted}" is not installed on the Ollama server (run: ollama pull ${wanted})`);
		}
		await chat(ctx, 'Reply with the JSON {"results":[]} and nothing else.');
	},

	async judge(ctx, input) {
		return parseVerdicts(await chat(ctx, buildPrompt(input)), input.candidates);
	},
};

module.exports = provider;
