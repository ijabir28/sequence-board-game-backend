// Which signed-in players have the app open: a player is online while at least one of their sockets is connected
// and was identified as them (socket.js reads the session cookie its handshake carried). Kept in memory, so after a
// restart everyone is offline until their page reconnects (which it does by itself). The friends list shows it.

const sockets = new Map();

/** Whether `handle` has the app open anywhere. */
function is_online(handle) {
    return sockets.has(handle);
}

/** `connection` (a socket id) is signed in as `handle`. Returns whether that brought them online. */
function arrive({handle, connection}) {
    const arrived = !sockets.has(handle);
    if (arrived) sockets.set(handle, new Set());
    sockets.get(handle).add(connection);
    return arrived;
}

/** `connection` closed. Returns whether that took them offline. */
function depart({handle, connection}) {
    const connections = sockets.get(handle);
    if (connections === undefined) return false;
    connections.delete(connection);
    if (connections.size > 0) return false;
    sockets.delete(handle);
    return true;
}

/** Forgets everyone (for tests). */
function reset() {
    sockets.clear();
}

module.exports = {is_online, arrive, depart, reset};
