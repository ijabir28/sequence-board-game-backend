const db_friends = require('../database/friends');

// Tells a player's friends when their status on the friends list changes: they came online or went offline
// (controller/online.js), or sat down at or walked away from their game (controller/presence.js). Friends who have the
// app open hear `friends_updated` and read the list again. A burst of changes (a page reload drops and reopens the
// socket, then rejoins the game) is told once, after it settles.

const SETTLE_MS = 1500;

const pending = new Map();

/** `handle`'s status may have changed. */
function changed(handle) {
    if (typeof handle !== 'string' || pending.has(handle)) return;
    const timer = setTimeout(function () {
        pending.delete(handle);
        tell_friends(handle).catch(function (e) {
            console.error(`Could not tell ${handle}'s friends about their status:`, e.message);
        });
    }, SETTLE_MS);
    timer.unref();
    pending.set(handle, timer);
}

async function tell_friends(handle) {
    // Required here: socket.js requires this module.
    const socket_server = require('../socket');
    const online = require('./online');
    (await db_friends.friend_handles({handle})).forEach(function (friend) {
        if (online.is_online(friend)) socket_server.send_to({handle: friend, event: 'friends_updated', data: {}});
    });
}

/** Forgets what was waiting (for tests). */
function reset() {
    pending.forEach(clearTimeout);
    pending.clear();
}

module.exports = {SETTLE_MS, changed, reset};
