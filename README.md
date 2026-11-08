# NodeBB Duplicate Guard

Helps keep a NodeBB forum free of duplicate topics.

- **Live suggestions while writing a topic**: as the user types a title/text, a compact panel shows existing topics that may already answer the question, ranked in two tiers ("likely the same question" prominently, "related topics" under a secondary heading). Each suggestion shows title, short excerpt, category, date, match percentage and a direct link. Suggestions never block posting.
- **Supervision area inside Flags**: topics that look like duplicates of an existing topic are queued for supervisors. Supervisors can dismiss, mark as duplicate, or merge into the original.
- **Personal notification switch**: every supervisor has their own on/off switch inside the Flags area. It is stored per user, survives logout, never hides the pending list, and never affects other users or the plugin's global settings.
- **Strong local engine (no AI required)**: IDF-weighted title/body similarity with Hebrew and English normalisation, stemming, Hebrew consonant roots and plural/possessive endings, bigrams and character trigrams, typo correction, built-in plus admin-defined synonym groups, and recovery of titles typed with the wrong keyboard layout (Hebrew typed on an English layout and vice versa). A match needs at least two shared meaningful terms, so a single common word never produces a suggestion. Works fully with no API key and no network.
- **Optional AI re-ranking**: modular providers (Google Gemini, Ollama for local models). The admin brings their own key; the plugin never depends on a key from the plugin author.

## Permissions vs. preferences

| Concept | Who decides | Where |
| --- | --- | --- |
| Permission to see/handle suspected duplicates | Forum administrator only (administrators + groups chosen in the ACP) | ACP -> Plugins -> Duplicate Guard |
| Receiving notifications about new suspicions | Each supervisor, for themselves | Flags page -> "Duplicate topics" panel |

## Install

```bash
cd /path/to/nodebb
npm install /path/to/NodeBB-Duplicate-Guard    # or: npm install git+https://github.com/hershaleh/NodeBB-Duplicate-Guard.git
./nodebb build && ./nodebb restart
```

Then activate **nodebb-plugin-duplicate-guard** in ACP -> Extend -> Plugins and open ACP -> Plugins -> **Duplicate Guard**.
Requires NodeBB 3.x or 4.x and Node.js 18+. No npm dependencies.

## AI providers and data handling

AI is **off by default**. To enable it the administrator must pick a provider, (for Gemini) save a key, tick the explicit consent box (which states what is sent) and switch AI on. Withdrawing consent or deleting the key switches AI off again.

- API keys are stored **server-side only**, encrypted with AES-256-GCM (key derived from the forum's `secret`), never sent to the browser, never returned by any route (only "a key is saved"), never placed in URLs (Gemini receives it in a header) and scrubbed from error messages.
- What may be sent: the title and first part of the text of the topic being written/reviewed plus titles and short excerpts of up to six similar existing topics. Topic text is passed to the model as delimited, untrusted data.
- If the provider fails or times out, the plugin silently falls back to the local engine.
- **Ollama** needs no key; set the server address (default `http://127.0.0.1:11434`) and pick an installed model.

### Adding another provider

Register an object `{ id, name, requiresKey, defaultModel, models, dataNotice, listModels(ctx), test(ctx), judge(ctx, { query, candidates }) }` through the `filter:duplicate-guard.providers` hook (return it in `data.providers`). See `lib/providers/gemini.js`.

## Development

Everything runs locally; the repository intentionally contains **no CI / GitHub Actions workflows**.

```bash
npm test     # node:test, no dependencies, no network, no NodeBB install needed
```

The tests stub NodeBB internals (`lib/nbb.js` indirection) and cover: similarity engine, key encryption and leakage, consent rules, permission vs. notification separation, persistence of preferences, Flags area behaviour (including when it is switched off), suspect workflow, detection with/without AI, AI failure fallback, provider requests (mocked `fetch`), and rate limiting.

## Status / limitations

Verified with the local test suite only. It has not yet been run inside a live NodeBB instance: the client-side hooks (`action:composer.loaded`, Flags list injection) and routing helpers follow NodeBB 3.x/4.x conventions and should be smoke-tested on a staging forum before production use.
