const db_room = require('../database/rooms');
const db_game = require('../database/games');
const {transaction} = require('../database/pool');
const socket_server = require('../socket');
const {broadcast_room} = require('./room');
const {RuleError, create_game, random_first_seat, next_first_seat, apply_move, view_for, random_move} = require('../entity/sequence_game');
const {suggest_move} = require('../entity/hints');
const {round_stats, series_summary} = require('../entity/rounds');
const presence = require('./presence');

// A game played at a room's table. Errors are JSON: {error: CODE, message}.

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
    NOT_A_PLAYER: 403,
    NOT_HOST: 403,
    ROOM_NOT_FOUND: 404,
    GAME_NOT_FOUND: 404,
    GAME_ALREADY_STARTED: 409,
    TABLE_NOT_FULL: 409,
    NOT_YOUR_TURN: 409,
    GAME_OVER: 409,
    ROUND_IN_PROGRESS: 409,
    ROUNDS_OVER: 409,
    HISTORY_DISABLED: 403,
};

class GameError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function send_error(res, e) {
    // The answer went out and a broadcast after it failed: nothing is left to tell the client.
    if (res.headersSent) return console.error(e);
    if (e instanceof GameError || e instanceof RuleError) {
        return res.status(STATUS_BY_ERROR[e.code] || 400).send({error: e.code, message: e.message});
    }
    console.error(e);
    res.status(500).send({error: 'SERVER_ERROR', message: 'Something went wrong on the server.'});
}

async function find_room(id, client) {
    const room = await db_room.get({id, client, lock: true});
    if (room === undefined) throw new GameError('ROOM_NOT_FOUND', 'There is no table with that code.');
    return room;
}

// {room, game}. With `client` (inside a transaction) the game row stays locked until the transaction ends, so
// two moves on the same table can't interleave.
async function find_game(id, client) {
    const room = await db_room.get({id, client});
    if (room === undefined) throw new GameError('ROOM_NOT_FOUND', 'There is no table with that code.');
    const game = await db_game.get({room_id: id, client, lock: client !== undefined});
    if (game === undefined) throw new GameError('GAME_NOT_FOUND', "This table's game hasn't started yet.");
    return {room, game};
}

// When the current turn's time is up: its start plus the room's turn_seconds plus the time it spent paused.
function turn_end(room, game) {
    return Date.parse(game.turn_started_at) + room.settings.turn_seconds * 1000 + (game.turn_paused_ms || 0);
}

// When the current turn's timer runs out. Null once the game is over, while the turn is paused (its player is away
// from the table), or for a game stored before turns were stamped.
function turn_deadline(room, game) {
    if (game.winner !== null || !game.turn_started_at || game.turn_paused_at) return null;
    return new Date(turn_end(room, game));
}

// The time left on a paused turn, frozen when it was paused. Null while the turn runs.
function paused_time_left(room, game) {
    if (game.winner !== null || !game.turn_started_at || !game.turn_paused_at) return null;
    return Math.max(0, turn_end(room, game) - Date.parse(game.turn_paused_at));
}

// The current player left the table: the turn timer stops until they're back. Nobody plays for them meanwhile.
function pause_turn(game, now = new Date()) {
    if (game.winner !== null || !game.turn_started_at || game.turn_paused_at) return game;
    return Object.assign({}, game, {turn_paused_at: now.toISOString()});
}

// The current player is back: the timer runs on from exactly where it stopped. The time spent away is added to the
// turn, so the time left is what it was when they left.
function resume_turn(room, game, now = new Date()) {
    if (!game.turn_paused_at) return game;
    const paused_ms = (game.turn_paused_ms || 0) + Math.max(0, now - Date.parse(game.turn_paused_at));
    return Object.assign({}, game, {turn_paused_at: null, turn_paused_ms: paused_ms});
}

// Pauses the turn if its player is away from the table and resumes it once they're back. `acting` is someone known to
// be there (the player who just moved), whether or not their game page has a socket open.
function follow_presence(room, game, now = new Date(), acting = null) {
    if (game.winner !== null || !game.turn_started_at) return game;
    const handle = game.players[game.current].handle;
    return handle === acting || presence.is_present(room.id, handle) ? resume_turn(room, game, now) : pause_turn(game, now);
}

// Seated players whose game page isn't open.
function away_players(room, game) {
    return game.players
        .filter(function (player) {
            return !presence.is_present(room.id, player.handle);
        })
        .map(function (player) {
            return player.handle;
        });
}

// The statistics the round is saved with once it's won (none while it is played).
function stats_for(next) {
    return next.winner === null ? null : round_stats(next);
}

// Where the table is in its rounds, for the game view: {round, over, results, summary}. `results` are the won
// rounds' statistics (the current one too once it's won), and `summary` the final result once the host has ended
// the rounds, else null.
async function rounds_of(room, game, client) {
    const won = await db_game.list_rounds({room_id: room.id, client});
    const results = won.map(function (round) {
        // A round won before statistics were kept: the current one can still be summed up from its state.
        const stats = round.stats || (round.round === game.round ? round_stats(game) : null);
        return {round: round.round, winner: round.winner, started_at: round.started_at, finished_at: round.finished_at, stats};
    });
    const over = room.rounds_ended_at !== null && room.rounds_ended_at !== undefined;
    return {round: game.round || 1, over, results, summary: over ? series_summary(results, game.team_count) : null};
}

// The game as `handle` sees it, under the room's settings. Hints exist only in training games, and only for the
// player whose turn it is, so a standard game never sends one. `rounds` is from rounds_of().
function view(room, game, handle, rounds) {
    const seen = view_for(game, handle, room.settings);
    const hint = room.settings.mode === 'training' && seen.current_player !== null && seen.current_player === handle
        ? suggest_move(game)
        : null;
    // server_time lets clients run the turn timer from their own clock even when it is off.
    const deadline = turn_deadline(room, game);
    const seated = game.players.some(function (player) {
        return player.handle === handle;
    });
    return Object.assign(seen, {
        name: room.name,
        // The host deals each round, and decides after one is won whether to play another.
        host: room.administrator,
        rounds,
        hint,
        turn_started_at: game.turn_started_at || null,
        turn_deadline: deadline === null ? null : deadline.toISOString(),
        // While the current player is away the turn is paused: no deadline, and the time they'll have left.
        turn_paused: Boolean(game.winner === null && game.turn_paused_at),
        turn_time_left_ms: paused_time_left(room, game),
        away: away_players(room, game),
        // A seated player's game socket sends this to say they are at the table (see controller/presence.js).
        presence_token: seated ? presence.token_for(room.id, handle) : null,
        server_time: new Date().toISOString(),
    });
}

// The rules engine has no clock, so the time each turn started is stamped here, into the stored state (which
// keeps it across restarts). An exchange keeps the turn, so it keeps the time too.
function stamp_turn(previous, next, now = new Date()) {
    if (previous !== undefined && previous.turn === next.turn && previous.current === next.current) return next;
    return Object.assign({}, next, {turn_started_at: now.toISOString(), turn_paused_at: null, turn_paused_ms: 0});
}

function signed_in_handle(req) {
    const handle = req.handle;
    if (handle === undefined) throw new GameError('NOT_SIGNED_IN', 'Sign in to play.');
    return handle;
}

function broadcast_game(room_id) {
    socket_server.broadcast({event: 'game_updated', data: {room_id}});
}

// Express 4 doesn't catch rejected promises, so every handler reports its own errors.
function handler(action) {
    return function (req, res) {
        action(req, res).catch(function (e) {
            send_error(res, e);
        });
    };
}

/** POST /room/:id/start: deals a game for a full table. Only the table's creator (the host) may start it. */
async function start(req, res) {
    const {id} = req.params;
    const handle = signed_in_handle(req);
    const {room, game, rounds} = await transaction(async function (client) {
        const room = await find_room(id, client);
        if (room.administrator !== handle) {
            throw new GameError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, can start its game.`);
        }
        if (await db_game.get({room_id: id, client}) !== undefined) {
            throw new GameError('GAME_ALREADY_STARTED', "This table's game has already started.");
        }
        if (!db_room.is_full(room)) throw new GameError('TABLE_NOT_FULL', 'Every seat must be taken before the game can start.');

        // Players are still on the table page, so the first turn usually starts paused until its player opens the game.
        const now = new Date();
        // Who moves first in round 1 is drawn at random; each later round passes it to the next seat.
        const first = random_first_seat(room.teams);
        const dealt = Object.assign(create_game({teams: room.teams, rules: room.settings, first}), {round: 1});
        const created = follow_presence(room, stamp_turn(undefined, dealt, now), now);
        await db_game.create({room_id: id, state: created, turn_deadline: turn_deadline(room, created), client});
        return {room, game: created, rounds: await rounds_of(room, created, client)};
    });
    res.send(view(room, game, handle, rounds));
    broadcast_game(id);
    await broadcast_room({id});
}

/** GET /room/:id/game: the current round's game as the signed-in player sees it (only their own hand). */
async function get(req, res) {
    const {room, game} = await find_game(req.params.id);
    res.send(view(room, game, req.handle, await rounds_of(room, game)));
}

// The host's decision once a round is won: `decide(room, game, client)` runs with the room and the round locked,
// after checking the round is over and the rounds go on. Answers with the game view and tells every player.
function host_decision(decide) {
    return handler(async function (req, res) {
        const {id} = req.params;
        const handle = signed_in_handle(req);
        const {room, game, rounds} = await transaction(async function (client) {
            const room = await find_room(id, client);
            if (room.administrator !== handle) {
                throw new GameError('NOT_HOST', `Only ${room.administrator_name}, who opened this table, decides whether to play another round.`);
            }
            const current = await db_game.get({room_id: id, client, lock: true});
            if (current === undefined) throw new GameError('GAME_NOT_FOUND', "This table's game hasn't started yet.");
            if (room.rounds_ended_at !== null) throw new GameError('ROUNDS_OVER', "This table's rounds are over.");
            if (current.winner === null) throw new GameError('ROUND_IN_PROGRESS', 'This round is still being played.');
            const decided = await decide(room, current, client);
            return Object.assign({}, decided, {rounds: await rounds_of(decided.room, decided.game, client)});
        });
        res.send(view(room, game, handle, rounds));
        broadcast_game(id);
        await broadcast_room({id});
    });
}

/** POST /room/:id/rounds/next: the host deals another round with the same teams, once the current one is won. */
const next_round = host_decision(async function (room, current, client) {
    // A round won before statistics were kept gets them now, while its state is at hand.
    const won = await db_game.list_rounds({room_id: room.id, client});
    if (won.some(function (round) {
        return round.round === current.round && round.stats === null;
    })) {
        await db_game.save_stats({room_id: room.id, round: current.round, stats: round_stats(current), client});
    }
    const now = new Date();
    // The first turn moves on to the next seat, so it goes to the other team (see next_first_seat()).
    const first = next_first_seat(current);
    const dealt = Object.assign(create_game({teams: room.teams, rules: room.settings, first}), {round: current.round + 1});
    const created = follow_presence(room, stamp_turn(undefined, dealt, now), now);
    await db_game.create({room_id: room.id, state: created, turn_deadline: turn_deadline(room, created), client});
    return {room, game: created};
});

/** POST /room/:id/rounds/end: the host ends the rounds once one is won. The view then carries the final summary. */
const end_rounds = host_decision(async function (room, current, client) {
    await db_room.end_rounds({id: room.id, client});
    return {room: await db_room.get({id: room.id, client}), game: current};
});

/** GET /room/:id/turns: every move so far, oldest first. Public, like the game view, unless the room turned history off. */
async function turns(req, res) {
    const {room} = await find_game(req.params.id);
    if (!room.settings.history) throw new GameError('HISTORY_DISABLED', 'This table plays without move history.');
    res.send(await db_game.list_turns({room_id: req.params.id}));
}

function move_handler(build_move) {
    return handler(async function (req, res) {
        const {id} = req.params;
        const handle = signed_in_handle(req);
        const move = build_move(req.body || {});
        const {room, next, rounds} = await transaction(async function (client) {
            const {room, game} = await find_game(id, client);
            const seated = game.players.some(function (player) {
                return player.handle === handle;
            });
            if (!seated) throw new GameError('NOT_A_PLAYER', "You don't have a seat in this game.");

            const now = new Date();
            const played = follow_presence(room, stamp_turn(game, apply_move(game, handle, move), now), now, handle);
            await db_game.record_move({
                room_id: id, previous: game, next: played, handle, move,
                turn_deadline: turn_deadline(room, played), stats: stats_for(played), client,
            });
            return {room, next: played, rounds: await rounds_of(room, played, client)};
        });
        res.send(view(room, next, handle, rounds));
        broadcast_game(id);
    });
}

/** POST /room/:id/game/play  {hand_index, row, column} */
const play = move_handler(function (body) {
    return {type: 'play', hand_index: Number(body.hand_index), target: {row: Number(body.row), column: Number(body.column)}};
});

/** POST /room/:id/game/exchange  {hand_index} */
const exchange = move_handler(function (body) {
    return {type: 'exchange', hand_index: Number(body.hand_index)};
});

/** POST /room/:id/game/pass */
const pass = move_handler(function () {
    return {type: 'pass'};
});

// Marks what the timed-out player's moves did (this turn's place, remove, exchange or pass entries) with
// `timed_out: true`, so logs can say the move was made for them. The next player's auto-draw stays unmarked.
function mark_timed_out(previous, next) {
    const MOVES = ['place', 'remove', 'exchange', 'pass'];
    const added = next.log.slice(previous.log.length).map(function (entry) {
        return entry.turn === previous.turn && MOVES.includes(entry.kind) ? Object.assign({}, entry, {timed_out: true}) : entry;
    });
    return Object.assign({}, next, {log: previous.log.concat(added)});
}

/**
 * Plays for the current player of `room_id` if their turn timer has run out: a random playable card (after
 * exchanging a dead card if nothing else can be played), or a pass. If that player isn't at the table, their turn
 * is paused instead. Runs in one transaction with the game locked
 * and checks the deadline again inside it, so a move that just made it in time wins. Returns whether it played.
 */
async function expire_turn(room_id, now = new Date()) {
    const outcome = await transaction(async function (client) {
        const {room, game} = await find_game(room_id, client);
        const deadline = await db_game.get_deadline({room_id, client});
        if (game.winner !== null || deadline === null || deadline > now) return 'waiting';

        const player = game.players[game.current].handle;
        // Nobody plays for a player who isn't at the table: their turn waits for them (after a restart, for example,
        // before their page has reconnected).
        if (!presence.is_present(room.id, player)) {
            const paused = pause_turn(game, now);
            await db_game.save_state({room_id, state: paused, turn_deadline: null, client});
            return 'paused';
        }
        let state = game;
        // An exchange keeps the turn, so keep going until the turn is over (at most an exchange and a play).
        do {
            const move = random_move(state);
            const next = follow_presence(room, stamp_turn(state, mark_timed_out(state, apply_move(state, player, move)), now), now);
            await db_game.record_move({
                room_id, previous: state, next, handle: player, move,
                turn_deadline: turn_deadline(room, next), timed_out: true, stats: stats_for(next), client,
            });
            state = next;
        } while (state.winner === null && state.turn === game.turn && state.current === game.current);
        return 'played';
    });
    if (outcome !== 'waiting') broadcast_game(room_id);
    return outcome === 'played';
}

/**
 * A player opened or closed the game at `room_id` (see controller/presence.js): pauses the turn if its player has
 * left, resumes it if they're back, and tells everyone, so they can see who is away. Returns whether the turn
 * paused or resumed.
 */
async function presence_changed(room_id, now = new Date()) {
    const outcome = await transaction(async function (client) {
        const room = await db_room.get({id: room_id, client});
        const game = room === undefined ? undefined : await db_game.get({room_id, client, lock: true});
        if (game === undefined) return 'no game';
        const next = follow_presence(room, game, now);
        if (next === game) return 'unchanged';
        await db_game.save_state({room_id, state: next, turn_deadline: turn_deadline(room, next), client});
        return 'changed';
    });
    if (outcome !== 'no game') broadcast_game(room_id);
    return outcome === 'changed';
}

/** Plays for every player whose turn timer has run out. Returns how many turns it played. */
async function expire_overdue_turns(now = new Date()) {
    let count = 0;
    for (const room_id of await db_game.overdue({now})) {
        try {
            if (await expire_turn(room_id, now)) count++;
        } catch (e) {
            console.error(`Could not play the timed-out turn at ${room_id}:`, e);
        }
    }
    return count;
}

/**
 * Checks for timed-out turns every `interval_ms`, one sweep at a time. Started by bin/www (not by the app, so
 * tests stay in control). Returns a function that stops it.
 */
function start_turn_timer({interval_ms = 1000} = {}) {
    let running = false;
    const timer = setInterval(function () {
        if (running) return;
        running = true;
        expire_overdue_turns()
            .catch(function (e) {
                console.error('Turn timer sweep failed:', e.message);
            })
            .finally(function () {
                running = false;
            });
    }, interval_ms);
    timer.unref();
    return function () {
        clearInterval(timer);
    };
}

module.exports = {
    start: handler(start),
    get: handler(get),
    turns: handler(turns),
    play,
    exchange,
    pass,
    next_round,
    end_rounds,
    expire_turn,
    expire_overdue_turns,
    start_turn_timer,
    presence_changed,
};
