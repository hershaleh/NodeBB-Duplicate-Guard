'use strict';

/**
 * Two separate concepts, deliberately stored and checked separately:
 *
 *   1. Permission   - may this user see/handle suspected duplicates?
 *                     Decided ONLY by the forum admin (administrators + the
 *                     groups chosen in the plugin settings).
 *   2. Preference   - does this supervisor want notifications?
 *                     A personal per-user flag; it never affects permission,
 *                     never affects other users, never changes plugin settings.
 */

const nbb = require('./nbb');
const settings = require('./settings');

const Supervisors = {};

const prefKey = uid => `duplicateguard:user:${uid}`;

Supervisors.isSupervisor = async (uid) => {
	uid = parseInt(uid, 10);
	if (!uid) {
		return false;
	}
	const user = nbb('./src/user');
	if (await user.isAdministrator(uid)) {
		return true;
	}
	const { superviseGroups } = await settings.get();
	if (!superviseGroups.length) {
		return false;
	}
	const groups = nbb('./src/groups');
	const memberships = await groups.isMemberOfGroups(uid, superviseGroups);
	return memberships.some(Boolean);
};

Supervisors.getNotificationPref = async (uid) => {
	const db = nbb('./src/database');
	const stored = await db.getObjectField(prefKey(uid), 'notify');
	if (stored === null || stored === undefined) {
		return (await settings.get()).notificationsDefault;
	}
	return stored === '1' || stored === 1 || stored === true;
};

/** Only a supervisor can set their own preference; nobody can set someone else's. */
Supervisors.setNotificationPref = async (uid, enabled) => {
	if (!(await Supervisors.isSupervisor(uid))) {
		throw new Error('[[error:no-privileges]]');
	}
	const db = nbb('./src/database');
	await db.setObjectField(prefKey(uid), 'notify', enabled ? '1' : '0');
	return !!enabled;
};

Supervisors.getAllSupervisorUids = async () => {
	const groups = nbb('./src/groups');
	const { superviseGroups } = await settings.get();
	const lists = await Promise.all(['administrators', ...superviseGroups].map(name => groups.getMembers(name, 0, -1)));
	return Array.from(new Set(lists.flat().map(Number))).filter(Boolean);
};

/** Supervisors that should get a push notification: have permission AND notifications on. */
Supervisors.getNotifiable = async () => {
	const uids = await Supervisors.getAllSupervisorUids();
	const prefs = await Promise.all(uids.map(uid => Supervisors.getNotificationPref(uid)));
	return uids.filter((uid, i) => prefs[i]);
};

module.exports = Supervisors;
