const socket_io = require('socket.io');
const presence = require('./controller/presence');
const spectators = require('./controller/spectators');

const socket = socket_io({
    serveClient: true,
});

function broadcast({event, data}) {
    socket.emit(event, data);
}

// A game page says it is open with `join_game {room_id, handle, token}` (the token comes from that player's game
// view) and closed with `leave_game {room_id}`. A socket that drops counts as having left after a short grace period.
// Anyone with a table's link may watch its game, seated or not and signed in or not: `watch_game {room_id}` and
// `unwatch_game {room_id}`. Watching only counts them; every client hears `spectators_updated {room_id, count}`.
spectators.on_change(function (room_id, count) {
    broadcast({event: 'spectators_updated', data: {room_id, count}});
});

socket.on('connection', function (connection) {
    const joined = new Map();

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
        spectators.drop(connection.id);
        joined.forEach(function (handle, room_id) {
            presence.depart({room_id, handle, connection: connection.id, grace_ms: presence.DISCONNECT_GRACE_MS});
        });
        joined.clear();
    });
});

module.exports = {socket, broadcast};
