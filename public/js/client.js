'use strict';

/* globals $, require, ajaxify, config, app, document, window */

(function () {
	const BASE = '/plugins/duplicate-guard';
	const DEBOUNCE_MS = 700;

	const modules = {};
	const strings = {};

	function t(key, ...args) {
		let out = strings[key] || key;
		args.forEach((a, i) => { out = out.replace(`%${i + 1}`, a); });
		return out;
	}

	function loadStrings(translator) {
		const keys = [
			'suggest.title', 'suggest.subtitle', 'suggest.duplicate', 'suggest.related', 'suggest.match',
			'suggest.category', 'suggest.opened', 'suggest.collapse', 'suggest.expand', 'suggest.open',
			'flags.tab', 'flags.empty', 'flags.pending', 'flags.all', 'flags.notifications',
			'flags.notifications.help', 'flags.notifications.on', 'flags.notifications.off',
			'flags.duplicate-of', 'flags.dismiss', 'flags.confirm', 'flags.merge', 'flags.merge.confirm',
			'flags.status.pending', 'flags.status.dismissed', 'flags.status.confirmed', 'flags.status.merged',
			'flags.area-disabled', 'flags.error',
		];
		return Promise.all(keys.map(k => new Promise((resolve) => {
			// %1 / %2 are kept as literal placeholders and filled by t()
			translator.translate(`[[duplicate-guard:${k}]]`, (txt) => { strings[k] = txt; resolve(); });
		})));
	}

	// All DOM is built with textContent so topic titles/excerpts can never inject markup.
	function el(tag, attrs, children) {
		const node = document.createElement(tag);
		Object.keys(attrs || {}).forEach((k) => {
			if (k === 'text') {
				node.textContent = attrs[k];
			} else if (k === 'class') {
				node.className = attrs[k];
			} else {
				node.setAttribute(k, attrs[k]);
			}
		});
		(children || []).forEach(c => c && node.appendChild(c));
		return node;
	}

	function topicUrl(item) {
		return `${config.relative_path}/topic/${item.slug}`;
	}

	function formatDate(ts) {
		return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	/* ===================================================== composer ===== */

	function suggestionCard(item) {
		const link = el('a', { href: topicUrl(item), target: '_blank', rel: 'noopener', class: 'dg-title', text: item.title });
		const meta = el('div', { class: 'dg-meta text-muted' }, [
			el('span', { class: 'dg-badge', text: t('suggest.match', item.score) }),
			item.category ? el('span', { text: `${t('suggest.category')}: ${item.category}` }) : null,
			el('span', { text: `${t('suggest.opened')}: ${formatDate(item.timestamp)}` }),
		]);
		return el('li', { class: `dg-item dg-${item.tier}` }, [
			link,
			item.excerpt ? el('div', { class: 'dg-excerpt text-muted', text: item.excerpt }) : null,
			meta,
		]);
	}

	function renderSuggestions($panel, items) {
		const panel = $panel[0];
		panel.textContent = '';
		if (!items.length) {
			$panel.addClass('dg-hidden');
			return;
		}
		const dups = items.filter(i => i.tier === 'duplicate');
		const related = items.filter(i => i.tier === 'related');

		const body = el('div', { class: 'dg-body' });
		if (dups.length) {
			body.appendChild(el('div', { class: 'dg-group-title', text: t('suggest.duplicate') }));
			body.appendChild(el('ul', { class: 'dg-list dg-primary' }, dups.map(suggestionCard)));
		}
		if (related.length) {
			body.appendChild(el('div', { class: 'dg-group-title dg-secondary-title', text: t('suggest.related') }));
			body.appendChild(el('ul', { class: 'dg-list dg-secondary' }, related.map(suggestionCard)));
		}

		const toggle = el('button', { type: 'button', class: 'btn btn-link btn-sm dg-toggle', text: t('suggest.collapse') });
		toggle.addEventListener('click', () => {
			const hidden = body.classList.toggle('dg-hidden');
			toggle.textContent = hidden ? t('suggest.expand') : t('suggest.collapse');
		});

		panel.appendChild(el('div', { class: 'dg-head' }, [
			el('div', {}, [
				el('strong', { text: t('suggest.title') }),
				el('div', { class: 'text-muted small', text: t('suggest.subtitle') }),
			]),
			toggle,
		]));
		panel.appendChild(body);
		$panel.removeClass('dg-hidden');
	}

	/**
	 * Delegated listeners instead of relying on composer events: whichever way NodeBB opens the composer
	 * (page, modal, mobile), typing in its title or body field is enough to attach the suggestions panel.
	 */
	const COMPOSER = '[component="composer"], .composer';
	const state = new WeakMap(); // composer element -> { $panel, timer, seq, lastKey }

	function composerState($composer) {
		const el = $composer[0];
		if (state.has(el)) {
			return state.get(el);
		}
		const $title = $composer.find('input.title').first();
		if (!$title.length) {
			return null; // replies and edits of non-first posts have no title field: nothing to suggest
		}
		const $panel = $('<div class="dg-suggest dg-hidden" aria-live="polite"></div>');
		const $anchor = $composer.find('.title-container').first();
		if ($anchor.length) {
			$anchor.after($panel);
		} else {
			$title.parent().after($panel);
		}
		const st = { $panel, timer: null, seq: 0, lastKey: '' };
		state.set(el, st);
		return st;
	}

	function runSuggest($composer, st) {
		const $title = $composer.find('input.title').first();
		const $write = $composer.find('textarea.write').first();
		const title = String($title.val() || '').trim();
		const content = String($write.val() || '').slice(0, 800);
		const key = `${title}\u0000${content.slice(0, 400)}`;
		if (title.length < 4) {
			st.lastKey = '';
			st.$panel.addClass('dg-hidden');
			return;
		}
		if (key === st.lastKey) {
			return;
		}
		st.lastKey = key;
		const mine = ++st.seq;
		modules.api.get(`${BASE}/suggest`, { title, content, cid: $composer.find('.category-list').val() })
			.then((res) => {
				if (mine !== st.seq) {
					return; // a newer request superseded this one
				}
				renderSuggestions(st.$panel, (res && res.items) || []);
			})
			.catch((err) => {
				// suggestions must never get in the way of writing
				st.$panel.addClass('dg-hidden');
				if (window.console) { window.console.warn('[duplicate-guard] suggestion request failed', err); }
			});
	}

	function onComposerInput() {
		const $composer = $(this).closest(COMPOSER);
		if (!$composer.length) {
			return;
		}
		const st = composerState($composer);
		if (!st) {
			return;
		}
		clearTimeout(st.timer);
		st.timer = setTimeout(() => runSuggest($composer, st), DEBOUNCE_MS);
	}

	/* ======================================================== flags ===== */

	function statusLabel(status) {
		return t(`flags.status.${status}`);
	}

	function suspectRow(row, reload) {
		const actions = el('div', { class: 'dg-actions' });
		if (row.status === 'pending') {
			const mk = (cls, text, handler) => {
				const b = el('button', { type: 'button', class: `btn btn-sm ${cls}`, text });
				b.addEventListener('click', () => {
					b.disabled = true;
					handler().then(reload).catch(() => {
						b.disabled = false;
						modules.alerts.error(t('flags.error'));
					});
				});
				actions.appendChild(b);
			};
			mk('btn-outline-secondary', t('flags.dismiss'), () => modules.api.post(`${BASE}/suspects/${row.tid}/dismiss`, {}));
			mk('btn-outline-primary', t('flags.confirm'), () => modules.api.post(`${BASE}/suspects/${row.tid}/confirm`, { merge: false }));
			mk('btn-primary', t('flags.merge'), () => {
				if (!window.confirm(t('flags.merge.confirm'))) {
					return Promise.reject(new Error('cancelled'));
				}
				return modules.api.post(`${BASE}/suspects/${row.tid}/confirm`, { merge: true });
			});
		}

		return el('li', { class: 'list-group-item dg-suspect' }, [
			el('div', { class: 'd-flex justify-content-between gap-2' }, [
				el('a', { href: topicUrl(row.topic), class: 'fw-semibold', text: row.topic.title }),
				el('span', { class: 'dg-badge', text: t('suggest.match', row.percent) }),
			]),
			el('div', { class: 'text-muted small', text: [row.topic.category, row.topic.author, formatDate(row.topic.timestamp), statusLabel(row.status)].filter(Boolean).join(' · ') }),
			row.excerpt ? el('div', { class: 'dg-excerpt text-muted', text: row.excerpt }) : null,
			el('div', { class: 'small mt-1' }, [
				el('span', { text: `${t('flags.duplicate-of')} ` }),
				el('a', { href: topicUrl(row.original), text: row.original.title }),
			]),
			actions,
		]);
	}

	async function renderFlagsPanel() {
		if (!ajaxify.data.template || ajaxify.data.template.name !== 'flags/list') {
			return;
		}
		$('#dg-flags-panel').remove();
		let me;
		try {
			me = await modules.api.get(`${BASE}/me`, {});
		} catch (err) {
			return;
		}
		if (!me || !me.supervisor || !me.areaEnabled) {
			return; // not allowed, or the administrator turned the area off: show nothing
		}

		const $host = $('[component="flags/list"]').first().length ? $('[component="flags/list"]').first() : $('#content > .flags, #content').first();
		const panel = el('section', { id: 'dg-flags-panel', class: 'card mb-3 dg-flags' });
		$host.before(panel);

		let status = 'pending';

		const draw = async () => {
			let data;
			try {
				data = await modules.api.get(`${BASE}/suspects`, { status });
			} catch (err) {
				panel.textContent = t('flags.error');
				return;
			}
			panel.textContent = '';

			// Personal notification preference: independent of permission and of other users.
			const toggle = el('input', { type: 'checkbox', class: 'form-check-input', id: 'dg-notify-toggle' });
			toggle.checked = !!me.notifications;
			toggle.addEventListener('change', () => {
				const wanted = toggle.checked;
				toggle.disabled = true;
				modules.api.put(`${BASE}/me/notifications`, { enabled: wanted }).then((res) => {
					me.notifications = res.notifications;
					modules.alerts.success(t(res.notifications ? 'flags.notifications.on' : 'flags.notifications.off'));
				}).catch(() => {
					toggle.checked = !wanted;
					modules.alerts.error(t('flags.error'));
				}).finally(() => { toggle.disabled = false; });
			});

			const tabs = el('div', { class: 'btn-group btn-group-sm' }, ['pending', 'all'].map((s) => {
				const b = el('button', { type: 'button', class: `btn btn-outline-secondary${status === s ? ' active' : ''}`, text: t(`flags.${s}`) });
				b.addEventListener('click', () => { status = s; draw(); });
				return b;
			}));

			panel.appendChild(el('div', { class: 'card-header d-flex flex-wrap justify-content-between align-items-center gap-2' }, [
				el('strong', { text: `${t('flags.tab')} (${data.total})` }),
				tabs,
			]));

			panel.appendChild(el('div', { class: 'card-body border-bottom' }, [
				el('div', { class: 'form-check form-switch' }, [
					toggle,
					el('label', { class: 'form-check-label', for: 'dg-notify-toggle', text: t('flags.notifications') }),
				]),
				el('div', { class: 'form-text', text: t('flags.notifications.help') }),
			]));

			if (!data.suspects.length) {
				panel.appendChild(el('div', { class: 'card-body text-muted', text: t('flags.empty') }));
			} else {
				panel.appendChild(el('ul', { class: 'list-group list-group-flush' }, data.suspects.map(r => suspectRow(r, draw))));
			}
		};

		draw();
		if (window.location.hash === '#duplicates') {
			panel.scrollIntoView();
		}
	}

	/* ========================================================= boot ===== */

	$(document).ready(() => {
		require(['api', 'alerts', 'translator'], (api, alerts, translator) => {
			modules.api = api;
			modules.alerts = alerts;
			loadStrings(translator).then(() => {
				$(document).on('input keyup change', `${COMPOSER.split(', ').map(c => `${c} input.title, ${c} textarea.write`).join(', ')}`, onComposerInput);
				$(window).on('action:ajaxify.end', renderFlagsPanel);
				renderFlagsPanel();
			});
		});
	});
}());
