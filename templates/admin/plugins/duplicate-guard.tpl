<div class="acp-page-container" id="dg-admin">
	<div class="row m-0">
		<div class="col-12 col-md-8 px-0 px-md-3">
			<h4 class="mb-3">[[duplicate-guard:title]]</h4>

			<div class="card mb-3">
				<div class="card-header">[[duplicate-guard:admin.general]]</div>
				<div class="card-body">
					<div class="form-check mb-2">
						<input class="form-check-input" type="checkbox" id="dg-enabled" data-key="enabled">
						<label class="form-check-label" for="dg-enabled">[[duplicate-guard:admin.enabled]]</label>
					</div>
					<div class="form-check mb-2">
						<input class="form-check-input" type="checkbox" id="dg-suggestions" data-key="suggestionsEnabled">
						<label class="form-check-label" for="dg-suggestions">[[duplicate-guard:admin.suggestions]]</label>
					</div>
					<div class="form-check mb-3">
						<input class="form-check-input" type="checkbox" id="dg-flags-area" data-key="flagsAreaEnabled">
						<label class="form-check-label" for="dg-flags-area">[[duplicate-guard:admin.flags-area]]</label>
					</div>
					<div class="mb-3">
						<label class="form-label" for="dg-max">[[duplicate-guard:admin.max-suggestions]]</label>
						<input class="form-control" type="number" min="1" max="10" id="dg-max" data-key="maxSuggestions">
					</div>
					<div class="mb-0">
						<label class="form-label" for="dg-index-limit">[[duplicate-guard:admin.index-limit]]</label>
						<input class="form-control" type="number" min="100" max="50000" id="dg-index-limit" data-key="indexLimit">
					</div>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-header">[[duplicate-guard:admin.thresholds]]</div>
				<div class="card-body">
					<div class="mb-3">
						<label class="form-label" for="dg-dup">[[duplicate-guard:admin.duplicate-threshold]]</label>
						<input class="form-control" type="number" step="0.01" min="0.4" max="1" id="dg-dup" data-key="suggestDuplicateThreshold">
					</div>
					<div class="mb-3">
						<label class="form-label" for="dg-rel">[[duplicate-guard:admin.related-threshold]]</label>
						<input class="form-control" type="number" step="0.01" min="0.2" max="0.95" id="dg-rel" data-key="suggestRelatedThreshold">
					</div>
					<div class="mb-0">
						<label class="form-label" for="dg-suspect">[[duplicate-guard:admin.suspect-threshold]]</label>
						<input class="form-control" type="number" step="0.01" min="0.4" max="1" id="dg-suspect" data-key="suspectThreshold">
					</div>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-header">[[duplicate-guard:admin.supervisors]]</div>
				<div class="card-body">
					<p class="text-muted">[[duplicate-guard:admin.supervisors.help]]</p>
					<select id="dg-groups" class="form-select mb-3" multiple size="6"></select>
					<div class="form-check mb-0">
						<input class="form-check-input" type="checkbox" id="dg-notif-default" data-key="notificationsDefault">
						<label class="form-check-label" for="dg-notif-default">[[duplicate-guard:admin.notifications-default]]</label>
					</div>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-header">[[duplicate-guard:admin.ai]]</div>
				<div class="card-body">
					<p class="text-muted">[[duplicate-guard:admin.ai.help]]</p>

					<div class="mb-3">
						<label class="form-label" for="dg-provider">[[duplicate-guard:admin.ai.provider]]</label>
						<select id="dg-provider" class="form-select"></select>
					</div>

					<div class="mb-3" id="dg-ollama-row">
						<label class="form-label" for="dg-ollama-url">[[duplicate-guard:admin.ai.ollama-url]]</label>
						<input class="form-control" type="url" id="dg-ollama-url" placeholder="http://127.0.0.1:11434">
					</div>

					<div class="mb-3" id="dg-key-row">
						<label class="form-label" for="dg-key">[[duplicate-guard:admin.ai.key]]</label>
						<div class="small text-muted mb-1" id="dg-key-state"></div>
						<div class="input-group">
							<input class="form-control" type="password" id="dg-key" autocomplete="new-password" spellcheck="false">
							<button class="btn btn-outline-primary" type="button" id="dg-key-save">[[duplicate-guard:admin.ai.key.save]]</button>
							<button class="btn btn-outline-danger" type="button" id="dg-key-delete">[[duplicate-guard:admin.ai.key.delete]]</button>
						</div>
					</div>

					<div class="mb-3" id="dg-model-row">
						<label class="form-label" for="dg-model">[[duplicate-guard:admin.ai.model]]</label>
						<div class="input-group">
							<select id="dg-model" class="form-select"></select>
							<button class="btn btn-outline-secondary" type="button" id="dg-models-refresh">[[duplicate-guard:admin.ai.refresh-models]]</button>
						</div>
					</div>

					<div class="mb-3">
						<button class="btn btn-outline-secondary" type="button" id="dg-test">[[duplicate-guard:admin.ai.test]]</button>
						<span class="ms-2" id="dg-test-result"></span>
					</div>

					<div class="alert alert-warning" id="dg-notice-box">
						<div class="form-check">
							<input class="form-check-input" type="checkbox" id="dg-consent">
							<label class="form-check-label" for="dg-consent">[[duplicate-guard:admin.ai.consent]]</label>
						</div>
						<div class="mt-2 small" id="dg-notice"></div>
					</div>

					<div class="form-check mb-3">
						<input class="form-check-input" type="checkbox" id="dg-ai-enabled">
						<label class="form-check-label" for="dg-ai-enabled">[[duplicate-guard:admin.ai.enabled]]</label>
					</div>

					<button class="btn btn-outline-danger" type="button" id="dg-ai-off">[[duplicate-guard:admin.ai.disable-all]]</button>
				</div>
			</div>
		</div>

		<div class="col-12 col-md-4 px-0 px-md-3">
			<div class="position-sticky" style="top: 1rem;">
				<button id="dg-save" class="btn btn-primary w-100" type="button">[[duplicate-guard:admin.save]]</button>
			</div>
		</div>
	</div>
</div>
