const {SERVER_ERROR_MESSAGE} = require('./errors');
const db_room = require('../database/rooms');
const db_user = require('../database/users');
const db_game = require('../database/games');
const db_friends = require('../database/friends');
const {transaction} = require('../database/pool');
const {is_supported_table} = require('../entity/sequence_game');
const {RoomError, normalize_name, generate_slug, parse_settings, shuffle_seats} = require('../entity/room');
const socket_server = require('../socket');

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
 * POST /room/:id/seat {handle, team_handle, seat}: the host puts a player at the table (seated, standing, invited, or
 * the host) in that seat (0-based within the team). A player sitting there trades places with them, or stands up if
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
        const at_table = player.handle === room.administrator
            || await db_room.is_member({id, user_id: player.id, client})
            || (await db_room.people({id, client})).invited.some(function (invited) {
                return invited.handle === player.handle;
            });
        if (!at_table) {
            throw new RoomError('NOT_AT_TABLE', `${player.name} isn't at this table. Invite them first.`);
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
        // Sitting down answers their invitation, as when they take a seat themself.
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
    room: handler(room),
    update_settings: handler(update_settings),
    leave: handler(leave),
    shuffle: handler(shuffle),
    seat: handler(seat),
    unseat: handler(unseat),
    kick: handler(kick),
    uninvite: handler(uninvite),
    room_payload,
    broadcast_room,
};
