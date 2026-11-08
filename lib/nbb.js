'use strict';

/**
 * Thin indirection over NodeBB's internal modules so that the plugin can be
 * unit-tested locally without a running NodeBB. In production every call is
 * simply `require.main.require(path)`.
 */

const overrides = new Map();

function load(name) {
	if (overrides.has(name)) {
		return overrides.get(name);
	}
	return require.main.require(name);
}

load.setOverride = (name, mod) => overrides.set(name, mod);
load.clearOverrides = () => overrides.clear();

module.exports = load;
