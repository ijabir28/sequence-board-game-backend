const {pool} = require('./pool');

// Rooms and their seats. Every function takes an optional `client`, so callers can run several of them in
// one transaction (see transaction() in pool.js).

function team_handle(index) {
    return `TEAM_${index + 1}`;
}

function team_index(handle, team_count) {
    const match = /^TEAM_(\d+)$/.exec(String(handle));
    const index = match ? Number(match[1]) - 1 : -1;
    return index >= 0 && index < team_count ? index : -1;
}

// The settings columns, as {setting: column}. See DEFAULT_SETTINGS in entity/room.js.
const SETTING_COLUMNS = {
    history: 'history_enabled',
    highlights: 'highlights_enabled',
    auto_draw_dead: 'auto_draw_dead',
    turn_seconds: 'turn_seconds',
    dead_cards: 'dead_cards',
    exchanges_per_turn: 'exchanges_per_turn',
};

const SETTINGS_SELECT = Object.entries(SETTING_COLUMNS).map(function ([key, column]) {
    return `rooms.${column} AS setting_${key}`;
}).join(', ');

// Moves the setting_* columns of a row into row.settings.
function read_settings(row) {
    row.settings = {};
    Object.keys(SETTING_COLUMNS).forEach(function (key) {
        row.settings[key] = row[`setting_${key}`];
        delete row[`setting_${key}`];
    });
    return row;
}

const UNIQUE_VIOLATION = '23505';

// Inserts the room with the first free code `make_id()` gives (codes are random, so a clash is rare).
// Returns the code. Not for use inside a transaction: a clash aborts it. `matchmaking` marks a table the matchmaking
// queue made (controller/matchmaking.js).
async function create({make_id, name, administrator_id, team_count, players_per_team, settings, matchmaking = false, client = pool, attempts = 5}) {
    const columns = Object.values(SETTING_COLUMNS);
    const values = Object.keys(SETTING_COLUMNS).map(function (key) {
        return settings[key];
    });
    for (let attempt = 1; ; attempt++) {
        const id = make_id();
        try {
            await client.query(
                `INSERT INTO rooms (id, name, administrator_id, team_count, players_per_team, matchmaking, ${columns.join(', ')})
                 VALUES ($1, $2, $3, $4, $5, $6, ${columns.map(function (_, i) {
                    return `$${i + 7}`;
                }).join(', ')})`,
                [id, name, administrator_id, team_count, players_per_team, matchmaking].concat(values)
            );
            return id;
        } catch (e) {
            if (e.code !== UNIQUE_VIOLATION || attempt >= attempts) throw e;
        }
    }
}

// Changes a room's name and settings. Call inside the transaction that checked the game hasn't started.
async function update({id, name, settings, client = pool}) {
    const keys = Object.keys(SETTING_COLUMNS);
    await client.query(
        `UPDATE rooms SET name = $2, ${keys.map(function (key, i) {
            return `${SETTING_COLUMNS[key]} = $${i + 3}`;
        }).join(', ')}
         WHERE id = $1`,
        [String(id), name].concat(keys.map(function (key) {
            return settings[key];
        }))
    );
}

// {id, name, administrator, administrator_name, team_count, players_per_team, created_at, rounds_ended_at, matchmaking,
//  settings: {mode, history, highlights, auto_draw_dead, turn_seconds, dead_cards, exchanges_per_turn},
//  teams: [{handle, players: [{handle, name, bot?} | null]}]} or undefined. `bot` is only there (true) for a bot. `lock` holds the room row until the
// transaction ends, which serialises joins, starts and settings changes.
async function get({id, client = pool, lock = false}) {
    const {rows} = await client.query(
        `SELECT rooms.id, rooms.name, users.handle AS administrator, users.name AS administrator_name,
                rooms.team_count, rooms.players_per_team,
                rooms.created_at, rooms.rounds_ended_at, rooms.matchmaking, ${SETTINGS_SELECT}
         FROM rooms JOIN users ON users.id = rooms.administrator_id
         WHERE rooms.id = $1 ${lock ? 'FOR UPDATE OF rooms' : ''}`,
        [String(id)]
    );
    const room = rows[0];
    if (room === undefined) {
        return undefined;
    }
    read_settings(room);
    const seats = await client.query(
        `SELECT room_seats.team, room_seats.seat, room_seats.user_id, users.handle, users.name, users.is_bot
         FROM room_seats JOIN users ON users.id = room_seats.user_id
         WHERE room_seats.room_id = $1`,
        [room.id]
    );
    room.teams = Array.from({length: room.team_count}, function (value, index) {
        return {handle: team_handle(index), players: Array(room.players_per_team).fill(null)};
    });
    // user_id stays on the room (for reseating) and out of the payload.
    room.seated_user_ids = {};
    seats.rows.forEach(function ({team, seat, user_id, handle, name, is_bot}) {
        room.teams[team].players[seat] = is_bot ? {handle, name, bot: true} : {handle, name};
        room.seated_user_ids[handle] = user_id;
    });
    return room;
}

function is_seated(room, handle) {
    return room.teams.some(function (team) {
        return team.players.some(function (player) {
            return player !== null && player.handle === handle;
        });
    });
}

function is_full(room) {
    return room.teams.every(function (team) {
        return team.players.every(function (player) {
            return player !== null;
        });
    });
}

// Seats the user in the first free seat of the team. Call inside a transaction: it locks the room so two
// players can't take the same seat. Throws ROOM_NOT_FOUND, TEAM_NOT_FOUND, ALREADY_SEATED or SEAT_TAKEN.
async function join({id, team_handle: handle, user, client}) {
    const room = await get({id, client, lock: true});
    if (room === undefined) {
        throw 'ROOM_NOT_FOUND';
    }
    const team = team_index(handle, room.team_count);
    if (team === -1) {
        throw 'TEAM_NOT_FOUND';
    }
    if (is_seated(room, user.handle)) {
        throw 'ALREADY_SEATED';
    }
    const seat = room.teams[team].players.indexOf(null);
    if (seat === -1) {
        throw 'SEAT_TAKEN';
    }
    await client.query(
        'INSERT INTO room_seats (room_id, team, seat, user_id) VALUES ($1, $2, $3, $4)',
        [room.id, team, seat, user.id]
    );
    await add_member({id: room.id, user_id: user.id, client});
}

// The user is at the table from now on, seated or not (migration 0024).
async function add_member({id, user_id, client = pool}) {
    await client.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(id), user_id]);
}

// Whether the user is at the table: seated, or stood up and still there.
async function is_member({id, user_id, client = pool}) {
    const {rowCount} = await client.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    return rowCount > 0;
}

// Puts the user in the seat, out of any other seat of theirs. Call inside the transaction that locked the room, checked
// the game hasn't started and freed the seat.
async function take_seat({id, team, seat, user_id, client}) {
    await client.query('DELETE FROM room_seats WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    await client.query('INSERT INTO room_seats (room_id, team, seat, user_id) VALUES ($1, $2, $3, $4)', [String(id), team, seat, user_id]);
    await add_member({id, user_id, client});
}

// Frees the user's seat, if they have one; they stay at the table. Returns whether they had one.
async function free_seat({id, user_id, client}) {
    const {rowCount} = await client.query('DELETE FROM room_seats WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    return rowCount > 0;
}

// The host sends the user away: out of their seat, off the table and its invitations, and kept from sitting down
// again. Call inside the transaction that locked the room and checked the game hasn't started.
async function remove_member({id, user_id, client}) {
    await client.query('DELETE FROM room_seats WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    await client.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    await client.query('DELETE FROM table_invitations WHERE room_id = $1 AND invitee_id = $2', [String(id), user_id]);
    await client.query('INSERT INTO room_bans (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(id), user_id]);
}

// Whether the host sent the user away from the table.
async function is_banned({id, user_id, client = pool}) {
    const {rowCount} = await client.query('SELECT 1 FROM room_bans WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
    return rowCount > 0;
}

// The host invited the user back: they may sit down again.
async function lift_ban({id, user_id, client = pool}) {
    await client.query('DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
}

// Who is around the table without a seat: {standing: [{handle, name}], invited: [{handle, name, invited_by}]}.
// Standing players are at the table (they stood up, or the host stood them up); invited ones were asked by a friend
// and haven't sat down yet. Each list is in the order they arrived.
async function people({id, client = pool}) {
    const standing = await client.query(
        `SELECT users.handle, users.name
         FROM room_members JOIN users ON users.id = room_members.user_id
         WHERE room_members.room_id = $1
           AND NOT EXISTS (SELECT 1 FROM room_seats WHERE room_seats.room_id = $1 AND room_seats.user_id = room_members.user_id)
         ORDER BY room_members.joined_at, users.handle`,
        [String(id)]
    );
    const invited = await client.query(
        `SELECT users.handle, users.name, inviters.handle AS invited_by
         FROM table_invitations
         JOIN users ON users.id = table_invitations.invitee_id
         JOIN users AS inviters ON inviters.id = table_invitations.inviter_id
         WHERE table_invitations.room_id = $1
           AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_members.room_id = $1 AND room_members.user_id = table_invitations.invitee_id)
         ORDER BY table_invitations.created_at, users.handle`,
        [String(id)]
    );
    return {standing: standing.rows, invited: invited.rows};
}

// The host ended the table's rounds. Call inside the transaction that locked the room.
async function end_rounds({id, client}) {
    await client.query('UPDATE rooms SET rounds_ended_at = now() WHERE id = $1', [String(id)]);
}

const USER_ROOMS_WHERE = `rooms.administrator_id = $1
         OR EXISTS (SELECT 1 FROM room_seats WHERE room_seats.room_id = rooms.id AND room_seats.user_id = $1)`;

// How many rooms list_for_user() can return in all, for paging.
async function count_for_user({user_id, client = pool}) {
    const {rows} = await client.query(`SELECT count(*)::INT AS total FROM rooms WHERE ${USER_ROOMS_WHERE}`, [user_id]);
    return rows[0].total;
}

// A user's rooms with how far each got: the columns of GET /user/rooms. $1 is the user's id. `your_team` is
// null when the user only created the room. The game columns are the current (latest) round's.
const USER_ROOMS_SELECT = `
        SELECT rooms.id, rooms.name, rooms.created_at, administrators.handle AS administrator,
               administrators.name AS administrator_name, ${SETTINGS_SELECT},
               rooms.team_count, rooms.players_per_team,
               my_seat.team AS your_team,
               (SELECT count(*)::INT FROM room_seats WHERE room_seats.room_id = rooms.id) AS seats_taken,
               CASE WHEN games.id IS NULL THEN 'open'
                    WHEN games.finished_at IS NULL THEN 'playing'
                    ELSE 'finished' END AS status,
               games.started_at, games.updated_at AS last_move_at, games.finished_at, games.winner_team,
               (SELECT count(*)::INT FROM turns WHERE turns.game_id = games.id) AS move_count,
               games.round, rooms.rounds_ended_at IS NOT NULL AS rounds_over, rooms.matchmaking
        FROM rooms
        JOIN users AS administrators ON administrators.id = rooms.administrator_id
        LEFT JOIN room_seats AS my_seat ON my_seat.room_id = rooms.id AND my_seat.user_id = $1
        LEFT JOIN games ON games.room_id = rooms.id
                       AND games.round = (SELECT max(round) FROM games AS latest WHERE latest.room_id = rooms.id)`;

// Frees the user's seat. Call inside the transaction that locked the room and checked the game hasn't
// started. Throws NOT_SEATED when the user has no seat here.
async function leave({id, user, client}) {
    const {rowCount} = await client.query('DELETE FROM room_seats WHERE room_id = $1 AND user_id = $2', [String(id), user.id]);
    if (rowCount === 0) {
        throw 'NOT_SEATED';
    }
}

// Replaces every seat with `seats` ([{team, seat, user_id}]). Call inside the transaction that locked the
// room and checked the game hasn't started.
async function reseat({id, seats, client}) {
    await client.query('DELETE FROM room_seats WHERE room_id = $1', [String(id)]);
    for (const {team, seat, user_id} of seats) {
        await client.query('INSERT INTO room_seats (room_id, team, seat, user_id) VALUES ($1, $2, $3, $4)', [String(id), team, seat, user_id]);
    }
}

// The rooms a user created or sat at, newest first (ties by code, so pages never overlap).
async function list_for_user({user_id, limit = 50, offset = 0, client = pool}) {
    const {rows} = await client.query(
        `${USER_ROOMS_SELECT}
         WHERE ${USER_ROOMS_WHERE}
         ORDER BY rooms.created_at DESC, rooms.id
         LIMIT $2 OFFSET $3`,
        [user_id, limit, offset]
    );
    return rows.map(read_settings);
}

// The game in progress at which the user has a seat and that moved most recently, or undefined: the one to
// offer first for resuming.
async function current_for_user({user_id, client = pool}) {
    const {rows} = await client.query(
        `${USER_ROOMS_SELECT}
         WHERE my_seat.user_id IS NOT NULL AND my_seat.forfeited_at IS NULL AND games.id IS NOT NULL AND games.finished_at IS NULL
         ORDER BY games.updated_at DESC, rooms.id
         LIMIT 1`,
        [user_id]
    );
    return rows[0] === undefined ? undefined : read_settings(rows[0]);
}

// The matchmaking game in progress at which the user has a seat (and hasn't forfeited), or undefined: one at a time,
// so the queue sends them back to it rather than into another.
async function current_match_for_user({user_id, client = pool}) {
    const {rows} = await client.query(
        `SELECT rooms.id FROM rooms
         JOIN room_seats ON room_seats.room_id = rooms.id AND room_seats.user_id = $1 AND room_seats.forfeited_at IS NULL
         JOIN games ON games.room_id = rooms.id
         WHERE rooms.matchmaking AND games.finished_at IS NULL
         ORDER BY rooms.created_at DESC
         LIMIT 1`,
        [user_id]
    );
    return rows[0] === undefined ? undefined : rows[0].id;
}

// The player forfeited their seat at a quick match. Call inside the transaction that locked the game.
async function forfeit_seat({id, user_id, client}) {
    await client.query('UPDATE room_seats SET forfeited_at = now() WHERE room_id = $1 AND user_id = $2', [String(id), user_id]);
}

module.exports = {
    forfeit_seat,
    create, update, get, is_seated, is_full, join, leave, reseat, end_rounds, list_for_user, count_for_user, current_for_user,
    current_match_for_user,
    add_member, is_member, take_seat, free_seat, remove_member, is_banned, lift_ban, people,
};
