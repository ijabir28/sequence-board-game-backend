const socket_io = require('socket.io');
const presence = require('./controller/presence');
const spectators = require('./controller/spectators');
const online = require('./controller/online');
const table_chat = require('./controller/table_chat');
const db_room = require('./database/rooms');

const socket = socket_io({
    serveClient: true,
});

function broadcast({event, data}) {
    socket.emit(event, data);
}

function user_room(handle) {
    return `user:${handle}`;
}

/** Sends `event` only to the sockets signed in as `handle` (see `identify` below), such as a friend request. */
function send_to({handle, event, data}) {
    socket.to(user_room(handle)).emit(event, data);
}

// Who a socket is: the session cookie its handshake carried, read once as it connects. A page whose player signs in
// or out reconnects, so its next handshake carries the new cookie. Only signed-in sockets hear send_to().
async function identify(connection) {
    // Required here: auth.js requires this module for its own broadcasts.
    const {auth} = require('./auth');
    const {fromNodeHeaders} = require('better-auth/node');
    const session = await auth.api.getSession({headers: fromNodeHeaders(connection.request.headers)});
    if (!session || !session.user) return undefined;
    return {handle: session.user.username, name: session.user.name || session.user.username};
}

// A game page says it is open with `join_game {room_id, handle, token}` (the token comes from that player's game
// view) and closed with `leave_game {room_id}`. A socket that drops counts as having left after a short grace period.
// Anyone with a table's link may watch its game, seated or not and signed in or not: `watch_game {room_id}` and
// `unwatch_game {room_id}`. Watching only counts them; every client hears `spectators_updated {room_id, count}`.
spectators.on_change(function (room_id, count) {
    broadcast({event: 'spectators_updated', data: {room_id, count}});
});

// The table's public chat and reactions (controller/table_chat.js): `open_table_chat {room_id}` from the lobby or the
// game page, then `send_table_chat` and `send_table_reaction`, which go to everyone with the table open.
async function room_exists(room_id) {
    return (await db_room.get({id: room_id})) !== undefined;
}

socket.on('connection', function (connection) {
    const joined = new Map();
    // The signed-in player, {handle, name}, once identified.
    let account;
    let closed = false;

    identify(connection)
        .then(function (signed_in) {
            if (signed_in === undefined || closed) return;
            account = signed_in;
            connection.join(user_room(account.handle));
            online.arrive({handle: account.handle, connection: connection.id});
        })
        .catch(function (e) {
            console.error(e);
        });

    table_chat.bind({
        connection,
        io: socket,
        account: function () {
            return account;
        },
        room_exists,
    });

    connection.on('join_game', function (data) {
        const {room_id, handle, token} = data || {};
        if (typeof room_id !== 'string' || !presence.verify_token(room_id, handle, token)) return;
        joined.set(room_id, handle);
        presence.arrive({room_id, handle, connection: connection.id});
    });

    connection.on('leave_game', function (data) {
        const room_id = data && data.room_id;
        if (!joined.has(room_id)) return;
        presence.depart({room_id, handle: joined.get(room_id), connection: connection.id});
        joined.delete(room_id);
    });

    connection.on('watch_game', function (data) {
        spectators.watch({room_id: data && data.room_id, connection: connection.id});
    });

    connection.on('unwatch_game', function (data) {
        spectators.unwatch({room_id: data && data.room_id, connection: connection.id});
    });

    connection.on('disconnect', function () {
        closed = true;
        if (account !== undefined) online.depart({handle: account.handle, connection: connection.id});
        spectators.drop(connection.id);
        joined.forEach(function (handle, room_id) {
            presence.depart({room_id, handle, connection: connection.id, grace_ms: presence.DISCONNECT_GRACE_MS});
        });
        joined.clear();
    });
});

module.exports = {socket, broadcast, send_to};
