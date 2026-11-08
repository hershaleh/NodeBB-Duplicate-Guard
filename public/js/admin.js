'use strict';

/* globals define, $, document */

define('admin/plugins/duplicate-guard', ['api', 'alerts', 'translator'], function (api, alerts, translator) {
	const Admin = {};
	const BASE = '/plugins/duplicate-guard/admin';
	let state = null; // last config returned by the server

	const t = key => new Promise(resolve => translator.translate(`[[duplicate-guard:${key}]]`, resolve));

	function fail(err) {
		t('admin.error').then(label => alerts.error(`${label}: ${(err && err.message) || err}`));
	}

	function provider() {
		return state.providers.find(p => p.id === $('#dg-provider').val()) || null;
	}

	function fillModels(models, selected) {
		const $m = $('#dg-model').empty();
		const list = models.slice();
		if (selected && !list.includes(selected)) {
			list.unshift(selected);
		}
		list.forEach((name) => {
			$('<option>').val(name).text(name).prop('selected', name === selected).appendTo($m);
		});
	}

	async function refreshKeyState() {
		const p = provider();
		const has = p && state.keyState[p.id];
		$('#dg-key-state').text(await t(has ? 'admin.ai.key.saved' : 'admin.ai.key.none'));
		$('#dg-key-delete').prop('disabled', !has);
		$('#dg-key').val('');
	}

	async function updateProviderUi() {
		const p = provider();
		const none = !p;
		$('#dg-key-row').toggle(!!p && p.requiresKey);
		$('#dg-ollama-row').toggle(!!p && p.id === 'ollama');
		$('#dg-model-row, #dg-notice-box, #dg-test').toggle(!none);
		$('#dg-test-result').text('');
		$('#dg-notice').text(p ? p.dataNotice : '');
		if (p) {
			fillModels(p.models, state.settings.aiProvider === p.id ? (state.settings.aiModel || p.defaultModel) : p.defaultModel);
			await refreshKeyState();
		}
	}

	function render(config) {
		state = config;
		const s = config.settings;
		$('#dg-admin [data-key]').each(function () {
			const $el = $(this);
			const key = $el.attr('data-key');
			if ($el.attr('type') === 'checkbox') {
				$el.prop('checked', !!s[key]);
			} else {
				$el.val(s[key]);
			}
		});

		const $g = $('#dg-groups').empty();
		const names = Array.from(new Set(config.allGroups.concat(s.superviseGroups)));
		names.forEach((name, i) => {
			const id = `dg-group-${i}`;
			const $row = $('<div class="form-check"></div>');
			$('<input class="form-check-input" type="checkbox">').attr('id', id).val(name).prop('checked', s.superviseGroups.includes(name)).appendTo($row);
			$('<label class="form-check-label"></label>').attr('for', id).text(name).appendTo($row);
			$row.appendTo($g);
		});
		if (!names.length) {
			t('admin.supervisors.none').then(msg => $g.text(msg).addClass('text-muted'));
		}

		const $p = $('#dg-provider').empty();
		t('admin.ai.provider.none').then((label) => {
			$('<option>').val('none').text(label).prop('selected', s.aiProvider === 'none').appendTo($p);
			config.providers.forEach((p) => {
				$('<option>').val(p.id).text(p.name).prop('selected', s.aiProvider === p.id).appendTo($p);
			});
			$('#dg-ollama-url').val(s.aiOllamaUrl);
			$('#dg-consent').prop('checked', !!s.aiConsent);
			$('#dg-ai-enabled').prop('checked', !!s.aiEnabled);
			updateProviderUi();
		});
	}

	function collect() {
		const out = {};
		$('#dg-admin [data-key]').each(function () {
			const $el = $(this);
			const key = $el.attr('data-key');
			out[key] = $el.attr('type') === 'checkbox' ? $el.is(':checked') : $el.val();
		});
		out.superviseGroups = $('#dg-groups input:checked').map(function () { return $(this).val(); }).get();
		out.aiProvider = $('#dg-provider').val() || 'none';
		out.aiModel = $('#dg-model').val() || '';
		out.aiOllamaUrl = $('#dg-ollama-url').val();
		out.aiConsent = $('#dg-consent').is(':checked');
		out.aiEnabled = $('#dg-ai-enabled').is(':checked');
		return out;
	}

	async function save(patch) {
		try {
			const config = await api.put(`${BASE}/config`, patch || collect());
			render(config);
			alerts.success(await t('admin.saved'));
		} catch (err) {
			fail(err);
		}
	}

	Admin.init = async function () {
		// translate the template explicitly so labels never show as raw [[keys]]
		await new Promise((resolve) => {
			translator.translate($('#dg-admin').html(), (html) => { $('#dg-admin').html(html); resolve(); });
		});
		try {
			render(await api.get(`${BASE}/config`, {}));
		} catch (err) {
			return fail(err);
		}

		$('#dg-save').on('click', () => save());
		$('#dg-provider').on('change', updateProviderUi);

		$('#dg-key-save').on('click', async () => {
			const p = provider();
			const apiKey = $('#dg-key').val();
			if (!p || !apiKey) {
				return;
			}
			try {
				await api.put(`${BASE}/key/${p.id}`, { apiKey });
				state.keyState[p.id] = true;
				await refreshKeyState();
				alerts.success(await t('admin.ai.key.saved-ok'));
			} catch (err) {
				fail(err);
			}
		});

		$('#dg-key-delete').on('click', async () => {
			const p = provider();
			if (!p) {
				return;
			}
			try {
				await api.del(`${BASE}/key/${p.id}`, {});
				state.keyState[p.id] = false;
				$('#dg-ai-enabled').prop('checked', false);
				await refreshKeyState();
				alerts.success(await t('admin.ai.key.deleted'));
			} catch (err) {
				fail(err);
			}
		});

		$('#dg-models-refresh').on('click', async () => {
			const p = provider();
			if (!p) {
				return;
			}
			try {
				const res = await api.get(`${BASE}/models/${p.id}`, { baseUrl: $('#dg-ollama-url').val() });
				fillModels(res.models, $('#dg-model').val());
				if (res.warning) {
					alerts.error(res.warning);
				}
			} catch (err) {
				fail(err);
			}
		});

		$('#dg-test').on('click', async () => {
			const p = provider();
			if (!p) {
				return;
			}
			const $r = $('#dg-test-result').removeClass('text-success text-danger').text('…');
			try {
				const res = await api.post(`${BASE}/test/${p.id}`, {
					model: $('#dg-model').val(),
					baseUrl: $('#dg-ollama-url').val(),
					apiKey: $('#dg-key').val() || undefined, // lets the admin test a key before saving it
				});
				$r.addClass(res.ok ? 'text-success' : 'text-danger').text(res.message);
			} catch (err) {
				$r.addClass('text-danger').text(err.message || String(err));
			}
		});

		$('#dg-ai-off').on('click', async () => {
			$('#dg-ai-enabled').prop('checked', false);
			$('#dg-provider').val('none');
			$('#dg-consent').prop('checked', false);
			await save();
		});
	};

	return Admin;
});
