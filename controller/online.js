// Which signed-in players have the app open: a player is online while at least one of their sockets is connected
// and was identified as them (socket.js reads the session cookie its handshake carried). Kept in memory, so after a
// restart everyone is offline until their page reconnects (which it does by itself). The friends list shows it.

const sockets = new Map();

/** Whether `handle` has the app open anywhere. */
function is_online(handle) {
    return sockets.has(handle);
}

/** `connection` (a socket id) is signed in as `handle`. */
function arrive({handle, connection}) {
    if (!sockets.has(handle)) sockets.set(handle, new Set());
    sockets.get(handle).add(connection);
}

/** `connection` closed. */
function depart({handle, connection}) {
    const connections = sockets.get(handle);
    if (connections === undefined) return;
    connections.delete(connection);
    if (connections.size === 0) sockets.delete(handle);
}

/** Forgets everyone (for tests). */
function reset() {
    sockets.clear();
}

module.exports = {is_online, arrive, depart, reset};
