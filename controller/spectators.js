// Who is watching each table's game without a seat: anyone with the link may, signed in or not. Kept in memory and
// counted by socket, so a viewer with two tabs open counts twice; after a restart the count starts again from the
// pages that reconnect (which they do by themselves). Watching is only a count: the game view a spectator reads is the
// same public one (no hand) whoever asks, and every move endpoint refuses anyone without a seat.

// A socket can watch a few tables at once (several tabs share one socket); more is someone filling the map.
const MAX_WATCHED_PER_CONNECTION = 5;
// Room codes are slugs of a name plus a suffix; anything longer isn't one.
const MAX_ROOM_ID_LENGTH = 80;

const tables = new Map();
const by_connection = new Map();
let listener = function () {};

function is_room_id(room_id) {
    return typeof room_id === 'string' && room_id.length > 0 && room_id.length <= MAX_ROOM_ID_LENGTH;
}

/** `fn(room_id, count)` is called whenever a table's number of spectators changes. */
function on_change(fn) {
    listener = fn;
}

/** How many sockets are watching the table's game. */
function count(room_id) {
    const watchers = tables.get(String(room_id));
    return watchers === undefined ? 0 : watchers.size;
}

/** `connection` (a socket id) started watching `room_id`. Returns whether it is now counted. */
function watch({room_id, connection}) {
    if (!is_room_id(room_id)) return false;
    const watched = by_connection.get(connection) || new Set();
    if (watched.has(room_id)) return true;
    if (watched.size >= MAX_WATCHED_PER_CONNECTION) return false;
    watched.add(room_id);
    by_connection.set(connection, watched);
    if (!tables.has(room_id)) tables.set(room_id, new Set());
    tables.get(room_id).add(connection);
    listener(room_id, count(room_id));
    return true;
}

/** `connection` stopped watching `room_id`. */
function unwatch({room_id, connection}) {
    const watched = by_connection.get(connection);
    if (watched === undefined || !watched.has(room_id)) return;
    watched.delete(room_id);
    if (watched.size === 0) by_connection.delete(connection);
    const watchers = tables.get(room_id);
    watchers.delete(connection);
    if (watchers.size === 0) tables.delete(room_id);
    listener(room_id, count(room_id));
}

/** `connection` closed: it watches nothing any more. */
function drop(connection) {
    const watched = by_connection.get(connection);
    if (watched === undefined) return;
    Array.from(watched).forEach(function (room_id) {
        unwatch({room_id, connection});
    });
}

/** Forgets every spectator (for tests). */
function reset() {
    tables.clear();
    by_connection.clear();
}

module.exports = {MAX_WATCHED_PER_CONNECTION, on_change, count, watch, unwatch, drop, reset};
