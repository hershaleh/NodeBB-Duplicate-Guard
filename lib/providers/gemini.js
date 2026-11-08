'use strict';

const { buildPrompt, parseVerdicts, httpJson } = require('./prompt');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function generate(ctx, text) {
	if (!ctx.apiKey) {
		throw new Error('A Google Gemini API key is required');
	}
	const model = encodeURIComponent(ctx.model || provider.defaultModel);
	// The key travels in a header (not the URL) so it does not end up in access logs.
	const body = await httpJson(`${BASE}/models/${model}:generateContent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
		body: JSON.stringify({
			contents: [{ role: 'user', parts: [{ text }] }],
			generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 512 },
		}),
	});
	const parts = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
	const out = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
	if (!out) {
		throw new Error('Gemini returned an empty response');
	}
	return out;
}

const provider = {
	id: 'gemini',
	name: 'Google Gemini',
	requiresKey: true,
	defaultModel: 'gemini-2.5-flash',
	models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
	dataNotice: 'The title and the first part of the text of a topic being written or reviewed, together with the titles and short excerpts of a few similar existing topics, are sent to Google.',

	async listModels(ctx) {
		if (!ctx.apiKey) {
			return provider.models;
		}
		const body = await httpJson(`${BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': ctx.apiKey } });
		const live = ((body && body.models) || [])
			.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
			.map(m => String(m.name || '').replace(/^models\//, ''))
			.filter(n => /^gemini-/.test(n));
		return live.length ? live : provider.models;
	},

	async test(ctx) {
		const out = await generate(ctx, 'Reply with the JSON {"results":[]} and nothing else.');
		JSON.parse(out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
	},

	async judge(ctx, input) {
		const out = await generate(ctx, buildPrompt(input));
		return parseVerdicts(out, input.candidates);
	},
};

module.exports = provider;
