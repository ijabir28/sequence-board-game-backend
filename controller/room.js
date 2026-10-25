const {SERVER_ERROR_MESSAGE} = require('./errors');
const db_room = require('../database/rooms');
const db_user = require('../database/users');
const db_game = require('../database/games');
const db_friends = require('../database/friends');
const {transaction} = require('../database/pool');
const {is_supported_table} = require('../entity/sequence_game');
const {RoomError, normalize_name, generate_slug, parse_settings, shuffle_seats} = require('../entity/room');
const socket_server = require('../socket');
const table_chat = require('./table_chat');

/**
 * POST /room/create {number_of_team, number_of_player_in_each_team, name?, history?, highlights?, auto_draw_dead?}:
 * 200 {id}, where id is the table's slug. Errors are JSON {error, message}.
 */
async function create(req, res) {
    const administrator = await db_user.get_user({handle: req.handle});
    if (administrator === undefined) {
        return res.status(401).send({error: 'NOT_SIGNED_IN', message: 'Sign in to open a table.'});
    }
    const team_count = Number(req.body.number_of_team);
    const players_per_team = Number(req.body.number_of_player_in_each_team);
    if (!is_supported_table(team_count, players_per_team)) {
        return res.status(400).send({
            error: 'UNSUPPORTED_TABLE',
            message: `A game can't be dealt for ${req.body.number_of_team} teams of ${req.body.number_of_player_in_each_team}.`,
        });
    }
    const name = normalize_name(req.body.name);
    const settings = parse_settings(req.body);
    const id = await db_room.create({
        make_id: function () {
            return generate_slug(name);
        },
        name,
        administrator_id: administrator.id,
        team_count,
        players_per_team,
        settings,
    });
    res.send({id});
}

/**
 * PATCH /room/:id/settings {name?, history?, highlights?, auto_draw_dead?}: only the table's creator, and only
 * before the game starts. 200 with the room; missing keys keep their value.
 */
async function update_settings(req, res) {
    const handle = req.handle;
    if (handle === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to change this table.');
    }
    const {id} = req.params;
    await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (room.administrator !== handle) {
            throw new RoomError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, can change its settings.`);
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new RoomError('GAME_ALREADY_STARTED', "The game has started, so the table's settings are fixed.");
        }
        const name = req.body.name === undefined ? room.name : normalize_name(req.body.name);
        await db_room.update({id, name, settings: parse_settings(req.body, room.settings), client});
    });
    res.send(await room_payload({id}));
    await broadcast_room({id});
}

/** POST /room/:id/join {team_handle}: always 200 {message}, see docs/api.md. */
async function join(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        return res.send({message: 'NOT_SIGNED_IN'});
    }
    const {id} = req.params;
    try {
        await transaction(async function (client) {
            if (await db_game.get({room_id: id, client}) !== undefined) {
                throw 'GAME_ALREADY_STARTED';
            }
            if (await db_room.is_banned({id, user_id: user.id, client})) {
                throw 'REMOVED_BY_HOST';
            }
            await db_room.join({id, team_handle: req.body.team_handle, user, client});
            // Sitting down answers a friend's invitation to this table.
            await db_friends.dismiss_invitation({user_id: user.id, room_id: id, client});
        });
    } catch (e) {
        if (typeof e !== 'string') throw e;
        return res.send({message: e});
    }
    res.send({message: 'success'});
    await broadcast_room({id});
}

/**
 * POST /room/:id/enter: a signed-in player opened the table's page. Before the game starts that puts them at the table
 * (unseated, so the host can seat them) and in their "Your tables", unless the host removed them or it is the host's own
 * table; coming by invitation answers it. 200 {member, removed}: whether they are at the table now, and whether the host
 * removed them.
 */
async function enter(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to sit at this table.');
    }
    const {id} = req.params;
    const result = await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (await db_room.is_banned({id, user_id: user.id, client})) {
            return {member: false, removed: true, added: false};
        }
        const started = await db_game.get({room_id: id, client}) !== undefined;
        if (started || room.matchmaking || room.administrator === user.handle) {
            return {member: await db_room.is_member({id, user_id: user.id, client}), removed: false, added: false};
        }
        const added = await db_room.add_member({id, user_id: user.id, client});
        // Coming to the table answers an invitation to it (without counting as turning it down).
        const answered = await db_friends.dismiss_invitation({user_id: user.id, room_id: id, client});
        return {member: true, removed: false, added: added || answered};
    });
    res.send({member: result.member, removed: result.removed});
    if (result.added) {
        socket_server.send_to({handle: user.handle, event: 'friends_updated', data: {}});
        await broadcast_room({id});
    }
}

/**
 * POST /room/:id/leave: stand up from your seat before the game starts, so you can take another (or let the
 * host reshuffle the teams). 200 with the room; JSON errors.
 */
async function leave(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to change seats.');
    }
    const {id} = req.params;
    await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new RoomError('GAME_ALREADY_STARTED', 'The game has started, so the seats are fixed.');
        }
        try {
            await db_room.leave({id, user, client});
        } catch (e) {
            if (e === 'NOT_SEATED') throw new RoomError('NOT_SEATED', "You don't have a seat at this table.");
            throw e;
        }
    });
    res.send(await room_payload({id}));
    await broadcast_room({id});
}

/** POST /room/:id/shuffle: the host deals the seated players out to the teams at random, before the game starts. */
async function shuffle(req, res) {
    const handle = req.handle;
    if (handle === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to change seats.');
    }
    const {id} = req.params;
    const host = await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (room.administrator !== handle) {
            throw new RoomError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, can shuffle the teams.`);
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new RoomError('GAME_ALREADY_STARTED', 'The game has started, so the seats are fixed.');
        }
        const seated = Object.values(room.seated_user_ids);
        const seats = shuffle_seats(seated, room.team_count, room.players_per_team).map(function ({team, seat, player}) {
            return {team, seat, user_id: player};
        });
        await db_room.reseat({id, seats, client});
        return {handle: room.administrator, name: room.administrator_name};
    });
    const payload = await room_payload({id});
    // Tells every player the teams were reshuffled (not just that a seat changed), with the new seating.
    socket_server.broadcast({event: 'teams_shuffled', data: {room_id: id, by: host, room: payload}});
    res.send(payload);
    await broadcast_room({id});
}

/**
 * Runs `action(client, room, player)` for the host, on another player at their table, before its game starts: the room
 * is locked, and `player` is the user `req.body.handle` names (or `req.params.handle`). `what` finishes "Only the host
 * can …" in the refusal. Returns what the action returns.
 */
async function as_host(req, what, action) {
    const handle = req.handle;
    if (handle === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to run this table.');
    }
    const {id} = req.params;
    const player_handle = (req.body && req.body.handle) || req.params.handle;
    return transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (room.administrator !== handle || room.matchmaking) {
            throw new RoomError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, can ${what}.`);
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new RoomError('GAME_ALREADY_STARTED', 'The game has started, so the seats are fixed.');
        }
        const player = typeof player_handle === 'string' ? await db_user.get_user({handle: player_handle}) : undefined;
        if (player === undefined) {
            throw new RoomError('PLAYER_NOT_FOUND', 'There is no player with that name.');
        }
        return action(client, room, player);
    });
}

/** The user's seat at the room as {team, seat}, or null. */
function seat_of(room, handle) {
    for (let team = 0; team < room.teams.length; team++) {
        const seat = room.teams[team].players.findIndex(function (player) {
            return player !== null && player.handle === handle;
        });
        if (seat !== -1) return {team, seat};
    }
    return null;
}

/**
 * POST /room/:id/seat {handle, team_handle, seat}: the host puts a player at the table (seated, or not seated yet: they
 * came by invitation, code or link) or the host themself in that seat (0-based within the team). An invited player who
 * hasn't come to the table yet can't be seated. A player sitting there trades places with them, or stands up if
 * the player had no seat. 200 with the room.
 */
async function seat(req, res) {
    const {id} = req.params;
    await as_host(req, 'choose where players sit', async function (client, room, player) {
        const team = Number(String(req.body.team_handle).replace(/^TEAM_/, '')) - 1;
        const index = Number(req.body.seat);
        if (!(team >= 0 && team < room.team_count && Number.isInteger(team)) || !(Number.isInteger(index) && index >= 0 && index < room.players_per_team)) {
            throw new RoomError('SEAT_NOT_FOUND', 'There is no such seat at this table.');
        }
        const at_table = player.handle === room.administrator || await db_room.is_member({id, user_id: player.id, client});
        if (!at_table) {
            throw new RoomError('NOT_AT_TABLE', `${player.name} hasn't come to this table yet. They can be seated once they open it.`);
        }
        const from = seat_of(room, player.handle);
        if (from !== null && from.team === team && from.seat === index) return;
        const occupant = room.teams[team].players[index];
        if (occupant !== null) {
            await db_room.free_seat({id, user_id: room.seated_user_ids[occupant.handle], client});
        }
        await db_room.take_seat({id, team, seat: index, user_id: player.id, client});
        if (occupant !== null && from !== null) {
            await db_room.take_seat({id, team: from.team, seat: from.seat, user_id: room.seated_user_ids[occupant.handle], client});
        }
        // A seat answers any invitation they still had, as when they take one themself.
        await db_friends.dismiss_invitation({user_id: player.id, room_id: id, client});
    });
    res.send(await room_payload({id}));
    await broadcast_room({id});
}

/** POST /room/:id/unseat {handle}: the host stands a player up. They stay at the table, so they can be seated again. */
async function unseat(req, res) {
    const {id} = req.params;
    await as_host(req, 'stand players up', async function (client, room, player) {
        if (!await db_room.free_seat({id, user_id: player.id, client})) {
            throw new RoomError('NOT_SEATED', `${player.name} doesn't have a seat at this table.`);
        }
    });
    res.send(await room_payload({id}));
    await broadcast_room({id});
}

/**
 * POST /room/:id/kick {handle}: the host sends a player away from the table. They lose their seat and any invitation,
 * and can't sit down again unless the host invites them back. 200 with the room.
 */
async function kick(req, res) {
    const {id} = req.params;
    const player = await as_host(req, 'send players away', async function (client, room, player) {
        if (player.handle === room.administrator) {
            throw new RoomError('CANNOT_KICK_SELF', "You opened this table, so you can't send yourself away.");
        }
        await db_room.remove_member({id, user_id: player.id, client});
        return player;
    });
    res.send(await room_payload({id}));
    socket_server.send_to({handle: player.handle, event: 'removed_from_table', data: {room_id: id}});
    socket_server.send_to({handle: player.handle, event: 'friends_updated', data: {}});
    await broadcast_room({id});
}

/** DELETE /room/:id/invitations/:handle: the host takes back a player's invitation to the table. 200 with the room. */
async function uninvite(req, res) {
    const {id} = req.params;
    const player = await as_host(req, 'take back invitations', async function (client, room, player) {
        if (!await db_friends.dismiss_invitation({user_id: player.id, room_id: id, client})) {
            throw new RoomError('NOT_INVITED', `${player.name} has no invitation to this table.`);
        }
        return player;
    });
    res.send(await room_payload({id}));
    // Their list of invitations drops this table.
    socket_server.send_to({handle: player.handle, event: 'friends_updated', data: {}});
    await broadcast_room({id});
}

/**
 * GET /room/:id/rejoin: whether the host sent you away from the table, and where your request to come back stands.
 * 200 {removed, requested, declined}.
 */
async function rejoin_status(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to see this table.');
    }
    const ban = await db_room.ban_of({id: req.params.id, user_id: user.id});
    res.send({removed: ban !== undefined, requested: ban !== undefined && ban.requested, declined: ban !== undefined && ban.declined});
}

/**
 * POST /room/:id/rejoin: a player the host sent away asks to come back, once, before the game starts. Needs no
 * friendship with the host, who hears `rejoin_requested {room_id, player}` and can let them back in or decline.
 * 200 {removed: true, requested: true, declined: false}.
 */
async function request_rejoin(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to ask to rejoin.');
    }
    const {id} = req.params;
    const room = await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new RoomError('GAME_ALREADY_STARTED', "The game has started, so nobody new can sit down.");
        }
        const ban = await db_room.ban_of({id, user_id: user.id, client});
        if (ban === undefined) {
            throw new RoomError('NOT_REMOVED', "You weren't removed from this table, so you can sit down without asking.");
        }
        if (ban.declined) {
            throw new RoomError('REJOIN_DECLINED', `${room.administrator_name} said no to your request to rejoin this table.`);
        }
        if (!await db_room.request_rejoin({id, user_id: user.id, client})) {
            throw new RoomError('ALREADY_ASKED', `You've already asked. ${room.administrator_name} hasn't answered yet.`);
        }
        return room;
    });
    res.send({removed: true, requested: true, declined: false});
    socket_server.send_to({handle: room.administrator, event: 'rejoin_requested', data: {room_id: id, player: {handle: user.handle, name: user.name}}});
}

/**
 * GET /room/:id/removed: the host's list of players they sent away, with any request to come back.
 * 200 {removed: [{handle, name, removed_at, rejoin_requested_at, rejoin_declined}]}.
 */
async function removed(req, res) {
    const handle = req.handle;
    if (handle === undefined) {
        throw new RoomError('NOT_SIGNED_IN', 'Sign in to run this table.');
    }
    const room = await db_room.get({id: req.params.id});
    if (room === undefined) {
        throw new RoomError('ROOM_NOT_FOUND', 'There is no table with that code.');
    }
    if (room.administrator !== handle) {
        throw new RoomError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, can see who was removed.`);
    }
    res.send({removed: await db_room.removed_players({id: room.id})});
}

/**
 * POST /room/:id/readmit {handle}: the host lets a player they sent away back to the table, friends or not. They are
 * at the table again (not seated, so the host or they can pick a seat) and hear `readmitted_to_table`. 200 with the room.
 */
async function readmit(req, res) {
    const {id} = req.params;
    const player = await as_host(req, 'let players back in', async function (client, room, player) {
        if (!await db_room.is_banned({id, user_id: player.id, client})) {
            throw new RoomError('NOT_REMOVED', `${player.name} wasn't removed from this table.`);
        }
        await db_room.lift_ban({id, user_id: player.id, client});
        await db_room.add_member({id, user_id: player.id, client});
        return player;
    });
    res.send(await room_payload({id}));
    socket_server.send_to({handle: player.handle, event: 'readmitted_to_table', data: {room_id: id}});
    await broadcast_room({id});
}

/** DELETE /room/:id/rejoin/:handle: the host says no to a removed player's request to come back. 204. */
async function decline_rejoin(req, res) {
    const {id} = req.params;
    const player = await as_host(req, 'answer requests to rejoin', async function (client, room, player) {
        if (!await db_room.decline_rejoin({id, user_id: player.id, client})) {
            throw new RoomError('NO_REJOIN_REQUEST', `${player.name} hasn't asked to rejoin this table.`);
        }
        return player;
    });
    res.status(204).send();
    socket_server.send_to({handle: player.handle, event: 'rejoin_declined', data: {room_id: id}});
}

// How long a table whose game hasn't started may sit untouched before it is deleted, and how often to look.
const OPEN_TABLE_IDLE_HOURS = Number(process.env.OPEN_TABLE_IDLE_HOURS) > 0 ? Number(process.env.OPEN_TABLE_IDLE_HOURS) : 24;
const OPEN_TABLE_SWEEP_MS = 60 * 60 * 1000;

/**
 * Deletes the tables whose game never started and that nobody touched for `idle_hours`, so abandoned tables don't
 * pile up in "Your tables". Pages open on one hear `room_updated` and find it gone; invited players' lists drop it.
 * Returns the deleted codes.
 */
async function delete_idle_open_tables({now = Date.now(), idle_hours = OPEN_TABLE_IDLE_HOURS} = {}) {
    const before = new Date(now - idle_hours * 60 * 60 * 1000);
    const {ids, invitees} = await transaction(function (client) {
        return db_room.delete_idle_open({before, client});
    });
    ids.forEach(function (id) {
        table_chat.forget(id);
        socket_server.broadcast({event: 'room_updated', data: {id, deleted: true}});
    });
    invitees.forEach(function (handle) {
        socket_server.send_to({handle, event: 'friends_updated', data: {}});
    });
    if (ids.length > 0) console.log(`Deleted ${ids.length} idle table${ids.length === 1 ? '' : 's'} whose game never started.`);
    return ids;
}

/**
 * Sweeps for idle open tables now and every `interval_ms` after, one sweep at a time. Started by bin/www (not by the
 * app, so tests stay in control). Returns a function that stops it.
 */
function start_open_table_cleanup({interval_ms = OPEN_TABLE_SWEEP_MS} = {}) {
    let running = false;
    const sweep = function () {
        if (running) return;
        running = true;
        delete_idle_open_tables()
            .catch(function (e) {
                console.error('Idle table sweep failed:', e.message);
            })
            .finally(function () {
                running = false;
            });
    };
    sweep();
    const timer = setInterval(sweep, interval_ms);
    timer.unref();
    return function () {
        clearInterval(timer);
    };
}

async function room_payload({id}) {
    const room = await db_room.get({id});
    if (room === undefined) {
        return undefined;
    }
    const game = await db_game.get({room_id: id});
    return {
        id: room.id,
        name: room.name,
        administrator: room.administrator,
        administrator_name: room.administrator_name,
        settings: room.settings,
        // Seats as players see them: whether one is a bot's stays on the server.
        teams: room.teams.map(function (team) {
            return Object.assign({}, team, {
                players: team.players.map(function (player) {
                    return player === null ? null : {handle: player.handle, name: player.name};
                }),
            });
        }),
        // Who is around the table without a seat: stood up, or invited and not yet sat down.
        ...await db_room.people({id}),
        created_at: room.created_at,
        game_started: game !== undefined,
        // The round being played (or just won), and whether the host has ended the rounds.
        round: game === undefined ? null : game.round,
        rounds_over: room.rounds_ended_at !== null,
    };
}

async function broadcast_room({id}) {
    socket_server.broadcast({event: 'room_updated', data: await room_payload({id})});
}

async function room(req, res) {
    res.send(await room_payload({id: req.params.id}));
}

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
    NOT_HOST: 403,
    ROOM_NOT_FOUND: 404,
    GAME_ALREADY_STARTED: 409,
    NOT_SEATED: 409,
    PLAYER_NOT_FOUND: 404,
    NOT_AT_TABLE: 409,
    NOT_INVITED: 409,
    NOT_REMOVED: 409,
    ALREADY_ASKED: 409,
    REJOIN_DECLINED: 403,
    NO_REJOIN_REQUEST: 409,
};

// Express 4 doesn't catch rejected promises; answer instead of leaving the request hanging.
function handler(action) {
    return function (req, res) {
        action(req, res).catch(function (e) {
            if (res.headersSent) return console.error(e);
            if (e instanceof RoomError) {
                return res.status(STATUS_BY_ERROR[e.code] || 400).send({error: e.code, message: e.message});
            }
            console.error(e);
            res.status(500).send({error: 'SERVER_ERROR', message: SERVER_ERROR_MESSAGE});
        });
    };
}

module.exports = {
    create: handler(create),
    join: handler(join),
    enter: handler(enter),
    room: handler(room),
    update_settings: handler(update_settings),
    leave: handler(leave),
    shuffle: handler(shuffle),
    seat: handler(seat),
    unseat: handler(unseat),
    kick: handler(kick),
    uninvite: handler(uninvite),
    rejoin_status: handler(rejoin_status),
    request_rejoin: handler(request_rejoin),
    removed: handler(removed),
    readmit: handler(readmit),
    decline_rejoin: handler(decline_rejoin),
    room_payload,
    broadcast_room,
    OPEN_TABLE_IDLE_HOURS,
    delete_idle_open_tables,
    start_open_table_cleanup,
};
