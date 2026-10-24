// Which signed-in players have the app open, and whether they are looking at it: a player is
// - 'online' while one of their sockets is connected, identified as them (socket.js reads the session cookie its
//   handshake carried), and its page is in view;
// - 'away' while all their sockets' pages are hidden (another tab or app, a locked phone). A hidden page lets its
//   socket go after a while to save the battery, so a socket that closes while away keeps them away for AWAY_MS more;
// - 'offline' otherwise.
// Kept in memory, so after a restart everyone is offline until their page reconnects (which it does by itself). The
// friends list shows it.

const AWAY_MS = 10 * 60 * 1000;

// handle → Map(connection → whether its page is hidden)
const sockets = new Map();
// handle → the timer that ends their lingering away, after their last away socket closed.
const lingering = new Map();
let listener = function () {};

/** `fn(handle)` is called whenever a player's status changes, including when lingering away runs out. */
function on_change(fn) {
    listener = fn;
}

/** 'online', 'away' or 'offline'. */
function status(handle) {
    const connections = sockets.get(handle);
    if (connections !== undefined) {
        for (const away of connections.values()) if (!away) return 'online';
        return 'away';
    }
    return lingering.has(handle) ? 'away' : 'offline';
}

/** Whether `handle` has the app open anywhere and in view. */
function is_online(handle) {
    return status(handle) === 'online';
}

/** Whether any of `handle`'s sockets is connected, in view or not. */
function is_connected(handle) {
    return sockets.has(handle);
}

// Applies `change` to `handle`'s sockets, and tells the listener if their status changed.
function update(handle, change) {
    const before = status(handle);
    change();
    if (status(handle) !== before) listener(handle);
}

function stop_lingering(handle) {
    clearTimeout(lingering.get(handle));
    lingering.delete(handle);
}

/** `connection` (a socket id) is signed in as `handle`; `away` if its page is hidden. */
function arrive({handle, connection, away = false}) {
    update(handle, function () {
        stop_lingering(handle);
        if (!sockets.has(handle)) sockets.set(handle, new Map());
        sockets.get(handle).set(connection, away);
    });
}

/** `connection`'s page was hidden (`away`) or came back into view. */
function set_away({handle, connection, away}) {
    const connections = sockets.get(handle);
    if (connections === undefined || !connections.has(connection)) return;
    update(handle, function () {
        connections.set(connection, away);
    });
}

/** `connection` closed. */
function depart({handle, connection}) {
    const connections = sockets.get(handle);
    if (connections === undefined || !connections.has(connection)) return;
    update(handle, function () {
        const was_away = connections.get(connection);
        connections.delete(connection);
        if (connections.size > 0) return;
        sockets.delete(handle);
        if (!was_away) return;
        const timer = setTimeout(function () {
            update(handle, function () {
                lingering.delete(handle);
            });
        }, AWAY_MS);
        timer.unref();
        lingering.set(handle, timer);
    });
}

/** Forgets everyone (for tests). */
function reset() {
    lingering.forEach(clearTimeout);
    lingering.clear();
    sockets.clear();
}

module.exports = {AWAY_MS, on_change, status, is_online, is_connected, arrive, set_away, depart, reset};
