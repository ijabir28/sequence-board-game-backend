const {SERVER_ERROR_MESSAGE} = require('./errors');
const db_room = require('../database/rooms');
const db_game = require('../database/games');
const db_user = require('../database/users');
const {transaction} = require('../database/pool');
const socket_server = require('../socket');
const {broadcast_room} = require('./room');
const {RuleError, create_game, random_first_seat, next_first_seat, apply_move, view_for, random_move} = require('../entity/sequence_game');
const {choose_move} = require('../entity/bot');
const {round_stats, series_summary} = require('../entity/rounds');
const presence = require('./presence');
const spectators = require('./spectators');

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
    ROUND_NOT_FOUND: 404,
    ROUNDS_OVER: 409,
    FORFEITED: 409,
    NOT_A_QUICK_MATCH: 409,
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
    res.status(500).send({error: 'SERVER_ERROR', message: SERVER_ERROR_MESSAGE});
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

// Blitz (a chess-style clock, see entity/room.js): `game.clocks` holds each team's time left in the round, in ms, as it
// stood when the current turn began. Games without it use the room's per-turn timer.
function has_clocks(game) {
    return Array.isArray(game.clocks);
}

// How long the current turn may run, paused time aside: the current team's clock under blitz, else the turn timer.
function turn_allowance_ms(room, game) {
    if (has_clocks(game)) return Math.max(0, game.clocks[game.players[game.current].team]);
    return room.settings.turn_seconds * 1000;
}

// A newly dealt round with every team's blitz clock full, when the room plays blitz.
function with_clocks(room, dealt) {
    if (room.settings.clock_seconds === null || room.settings.clock_seconds === undefined) return dealt;
    return Object.assign({}, dealt, {clocks: Array(dealt.team_count).fill(room.settings.clock_seconds * 1000)});
}

// When the current turn's time is up: its start plus its allowance plus the time it spent paused.
function turn_end(room, game) {
    return Date.parse(game.turn_started_at) + turn_allowance_ms(room, game) + (game.turn_paused_ms || 0);
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
// be there (the player who just moved), whether or not their game page has a socket open. A matchmaking table never
// waits: its players are strangers, so one who walks away has their turns played for them when the timer runs out.
function follow_presence(room, game, now = new Date(), acting = null) {
    if (game.winner !== null || !game.turn_started_at) return game;
    if (room.matchmaking) return resume_turn(room, game, now);
    const handle = game.players[game.current].handle;
    return handle === acting || presence.is_present(room.id, handle) ? resume_turn(room, game, now) : pause_turn(game, now);
}

// Seated players whose game page isn't open. Bots are always at the table.
function away_players(room, game) {
    return game.players
        .filter(function (player) {
            return !player.bot && !presence.is_present(room.id, player.handle);
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

// Whether `handle` forfeited this quick match: their seat is played by a bot now, or the game ended.
function has_forfeited(game, handle) {
    return Array.isArray(game.forfeited) && game.forfeited.includes(handle);
}

// The game as `handle` sees it, under the room's settings. `rounds` is from rounds_of(). A player who forfeited sees it
// as a spectator: their seat (and its hand) is no longer theirs.
function view(room, game, handle, rounds) {
    const forfeited = has_forfeited(game, handle);
    const seen = view_for(game, forfeited ? null : handle, room.settings);
    // server_time lets clients run the turn timer from their own clock even when it is off.
    const deadline = turn_deadline(room, game);
    const seated = !forfeited && game.players.some(function (player) {
        return player.handle === handle;
    });
    return Object.assign(seen, {
        name: room.name,
        // The host deals each round, and decides after one is won whether to play another.
        host: room.administrator,
        // Made by the Quick Match queue: one round, rated on the matchmaking leaderboard.
        matchmaking: room.matchmaking === true,
        // The viewer forfeited this quick match.
        forfeited,
        rounds,
        turn_started_at: game.turn_started_at || null,
        turn_deadline: deadline === null ? null : deadline.toISOString(),
        // While the current player is away the turn is paused: no deadline, and the time they'll have left.
        turn_paused: Boolean(game.winner === null && game.turn_paused_at),
        turn_time_left_ms: paused_time_left(room, game),
        // Blitz: each team's time left in the round (ms) as the current turn began; the current team's runs down to
        // turn_deadline (or is turn_time_left_ms while paused). Null with a per-turn timer.
        clocks: has_clocks(game) ? {seconds: room.settings.clock_seconds, left_ms: game.clocks} : null,
        away: away_players(room, game),
        // A seated player's game socket sends this to say they are at the table (see controller/presence.js).
        presence_token: seated ? presence.token_for(room.id, handle) : null,
        // How many people are watching without a seat (see controller/spectators.js).
        spectators: spectators.count(room.id),
        server_time: new Date().toISOString(),
    });
}

// Blitz: the clocks once `game`'s turn ends at `now`, its team's clock less the time the turn ran (not paused).
function spend_clock(game, now) {
    if (!game.turn_started_at) return game.clocks;
    const stopped = game.turn_paused_at ? Date.parse(game.turn_paused_at) : now.getTime();
    const used = Math.max(0, stopped - Date.parse(game.turn_started_at) - (game.turn_paused_ms || 0));
    const team = game.players[game.current].team;
    return game.clocks.map(function (left, index) {
        return index === team ? Math.max(0, left - used) : left;
    });
}

// The rules engine has no clock, so the time each turn started is stamped here, into the stored state (which
// keeps it across restarts). An exchange keeps the turn, so it keeps the time too. Under blitz the turn that ended is
// charged to its team's clock.
function stamp_turn(previous, next, now = new Date()) {
    if (previous !== undefined && previous.turn === next.turn && previous.current === next.current) return next;
    const stamped = {turn_started_at: now.toISOString(), turn_paused_at: null, turn_paused_ms: 0};
    if (previous !== undefined && has_clocks(previous)) stamped.clocks = spend_clock(previous, now);
    return Object.assign({}, next, stamped);
}

function signed_in_handle(req) {
    const handle = req.handle;
    if (handle === undefined) throw new GameError('NOT_SIGNED_IN', 'Sign in to play.');
    return handle;
}

// How long the players at a new matchmaking table get on top of the first turn's timer, to open the game: it doesn't
// wait for them (see follow_presence()).
const MATCH_START_GRACE_MS = 10000;

/**
 * Deals round 1 at a full table, inside the transaction that locked the room, and saves it. Returns the game state.
 * Players are still on the table page, so the first turn usually starts paused until its player opens the game (a
 * matchmaking table gives them a little extra time instead).
 */
async function deal_first_round(room, client, now = new Date()) {
    // Who moves first in round 1 is drawn at random; each later round passes it to the next seat.
    const first = random_first_seat(room.teams);
    const dealt = with_clocks(room, Object.assign(create_game({teams: room.teams, rules: room.settings, first}), {round: 1}));
    let created = follow_presence(room, stamp_turn(undefined, dealt, now), now);
    // The time a turn spent paused is added to it, so this is extra time for the first turn.
    if (room.matchmaking) created = Object.assign({}, created, {turn_paused_ms: MATCH_START_GRACE_MS});
    await db_game.create({room_id: room.id, state: created, turn_deadline: turn_deadline(room, created), client});
    return created;
}

// A matchmaking table plays a single round: the move that wins it also ends the rounds. Returns the room as it now is.
async function after_move(room, next, client) {
    if (!room.matchmaking || next.winner === null || room.rounds_ended_at !== null) return room;
    await db_room.end_rounds({id: room.id, client});
    return Object.assign({}, room, {rounds_ended_at: new Date()});
}

/**
 * Plays the current player's whole turn with moves from `choose(state)`, recording each: an exchange keeps the turn,
 * so it goes on until the turn is over (at most a few exchanges and a play). `mark(previous, next)` may change what a
 * move logged. Call inside the transaction that read `game` with a lock. Returns {room, state} after the turn.
 */
async function play_turn({room, game, choose, mark = null, timed_out = false, now, client}) {
    const seat = game.players[game.current];
    // A bot playing a forfeited seat moves as that seat, but the moves are its own in `turns`.
    const mover = seat.played_by || seat.handle;
    let state = game;
    do {
        const move = choose(state);
        const applied = apply_move(state, seat.handle, move);
        const next = follow_presence(room, stamp_turn(state, mark ? mark(state, applied) : applied, now), now);
        await db_game.record_move({
            room_id: room.id, previous: state, next, handle: mover, move,
            turn_deadline: turn_deadline(room, next), timed_out, stats: stats_for(next), client,
        });
        state = next;
    } while (state.winner === null && state.turn === game.turn && state.current === game.current);
    return {room: await after_move(room, state, client), state};
}

// Turns in a row a quick match player can let the timer play for them before they forfeit.
const MISSED_TURNS_TO_FORFEIT = 10;

// The game with `handle`'s count of turns missed in a row set to `count`.
function with_missed(game, handle, count) {
    return Object.assign({}, game, {missed: Object.assign({}, game.missed, {[handle]: count})});
}

/**
 * `handle` forfeits the quick match `game`, inside the transaction that locked it. With two teams the other team wins
 * at once and the round is rated as usual (the forfeiter's loss is marked as a forfeit). With three, the forfeiter
 * loses rating now, and a bot takes over their seat under their name for the rest of the game, so nobody else can
 * tell; whatever that seat does later, it rates nobody (see migration 0019). `auto` says it was for missing turns.
 * Returns {room, state}.
 */
async function forfeit_player({room, game, handle, auto = false, client}) {
    const seat = game.players.findIndex(function (player) {
        return player.handle === handle;
    });
    const player = game.players[seat];
    const user_id = await db_user.id_of({handle, client});
    await db_room.forfeit_seat({id: room.id, user_id, client});
    const forfeited = (game.forfeited || []).concat(handle);

    if (game.team_count === 2) {
        const winner = 1 - player.team;
        const state = Object.assign({}, game, {
            forfeited,
            winner,
            log: game.log.concat(
                {kind: 'forfeit', turn: game.turn, player: player.name, team: player.team, auto},
                {kind: 'win', turn: game.turn, team: winner}
            ),
        });
        await db_game.finish({room_id: room.id, state, stats: round_stats(state), client});
        await db_game.mark_forfeit({room_id: room.id, user_id, client});
        return {room: await after_move(room, state, client), state};
    }

    const taken = game.players.map(function (p) {
        return p.played_by || p.handle;
    });
    const [bot] = await db_user.random_bots({count: 1, except: taken, client});
    if (bot === undefined) throw new Error('No bot is free to take the seat.');
    await db_game.rate_forfeit({room_id: room.id, user_id, client});
    const players = game.players.map(function (p, i) {
        return i === seat ? Object.assign({}, p, {bot: true, played_by: bot.handle}) : p;
    });
    const state = with_missed(Object.assign({}, game, {players, forfeited}), handle, 0);
    await db_game.save_state({room_id: room.id, state, turn_deadline: turn_deadline(room, state), client});
    return {room, state};
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

        const created = await deal_first_round(room, client);
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

/**
 * GET /room/:id/rounds/:round: how a won round went, to look back on it: its statistics, the board as the round
 * ended and its whole move log (whatever the room's history setting: the round is over). Public, like the game view.
 */
async function round_detail(req, res) {
    const {room} = await find_game(req.params.id);
    const number = Number(req.params.round);
    const round = Number.isInteger(number) && number > 0 ? await db_game.get_round({room_id: room.id, round: number}) : undefined;
    if (round === undefined) throw new GameError('ROUND_NOT_FOUND', `This table has no round ${req.params.round}.`);
    if (round.finished_at === null) throw new GameError('ROUND_IN_PROGRESS', 'This round is still being played.');
    const {team_count, players, board, sequences, log} = view_for(round.state, null);
    res.send({
        round: round.round,
        winner: round.winner,
        started_at: round.started_at,
        finished_at: round.finished_at,
        // Rounds won before statistics were kept are summed up from their state.
        stats: round.stats || round_stats(round.state),
        team_count,
        players: players.map(function ({handle, name, team}) {
            return {handle, name, team};
        }),
        board,
        sequences,
        log,
    });
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
    const dealt = with_clocks(room, Object.assign(create_game({teams: room.teams, rules: room.settings, first}), {round: current.round + 1}));
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
            if (has_forfeited(game, handle)) throw new GameError('FORFEITED', 'You forfeited this match.');
            const seated = game.players.some(function (player) {
                return player.handle === handle;
            });
            if (!seated) throw new GameError('NOT_A_PLAYER', "You don't have a seat in this game.");

            const now = new Date();
            let played = follow_presence(room, stamp_turn(game, apply_move(game, handle, move), now), now, handle);
            // Moving for yourself ends a run of missed turns.
            if (room.matchmaking && game.missed && game.missed[handle]) played = with_missed(played, handle, 0);
            await db_game.record_move({
                room_id: id, previous: game, next: played, handle, move,
                turn_deadline: turn_deadline(room, played), stats: stats_for(played), client,
            });
            const after = await after_move(room, played, client);
            return {room: after, next: played, rounds: await rounds_of(after, played, client)};
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
 * POST /room/:id/game/forfeit: the signed-in player gives up their quick match (see forfeit_player()). Answers with the
 * game as they now see it.
 */
async function forfeit(req, res) {
    const {id} = req.params;
    const handle = signed_in_handle(req);
    const {room, state, rounds} = await transaction(async function (client) {
        const {room, game} = await find_game(id, client);
        if (!room.matchmaking) throw new GameError('NOT_A_QUICK_MATCH', 'Only quick matches can be forfeited.');
        if (has_forfeited(game, handle)) throw new GameError('FORFEITED', 'You forfeited this match.');
        const seated = game.players.some(function (player) {
            return player.handle === handle && !player.bot;
        });
        if (!seated) throw new GameError('NOT_A_PLAYER', "You don't have a seat in this game.");
        if (game.winner !== null) throw new GameError('GAME_OVER', 'The game is over.');
        const done = await forfeit_player({room, game, handle, client});
        return Object.assign(done, {rounds: await rounds_of(done.room, done.state, client)});
    });
    res.send(view(room, state, handle, rounds));
    broadcast_game(id);
    await broadcast_room({id});
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

        const player = game.players[game.current];
        // Nobody plays for a player who isn't at the table: their turn waits for them (after a restart, for example,
        // before their page has reconnected). Matchmaking tables and bots never wait.
        if (!room.matchmaking && !player.bot && !presence.is_present(room.id, player.handle)) {
            const paused = pause_turn(game, now);
            await db_game.save_state({room_id, state: paused, turn_deadline: null, client});
            return 'paused';
        }
        const played = await play_turn({
            room, game, now, client, timed_out: true, mark: mark_timed_out,
            choose: function (state) {
                return random_move(state);
            },
        });
        // A quick match player who keeps letting the timer play for them has left: after enough turns in a row
        // they forfeit.
        if (room.matchmaking && !player.bot && played.state.winner === null) {
            const missed = ((game.missed && game.missed[player.handle]) || 0) + 1;
            if (missed >= MISSED_TURNS_TO_FORFEIT) {
                await forfeit_player({room: played.room, game: played.state, handle: player.handle, auto: true, client});
            } else {
                const state = with_missed(played.state, player.handle, missed);
                await db_game.save_state({room_id, state, turn_deadline: turn_deadline(room, state), client});
            }
        }
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

// How long a bot thinks before it moves: a few seconds, different every turn, as a person would, and always well
// within the turn timer. Under blitz it spends at most a twentieth of its clock, so the clock lasts the round.
// BOT_THINK_MS is the shortest.
const BOT_THINK_MS = 1500;
const BOT_THINK_MAX_MS = 7000;

function bot_think_ms(room, game) {
    let hash = 0;
    for (const char of `${room.id}:${game.turn}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const allowance = turn_allowance_ms(room, game);
    const budget = has_clocks(game) ? Math.min(allowance - 4000, allowance / 20) : allowance - 4000;
    const longest = Math.max(BOT_THINK_MS, Math.floor(Math.min(BOT_THINK_MAX_MS, budget)));
    return BOT_THINK_MS + (hash % (longest - BOT_THINK_MS + 1));
}

// The bot's move, or a random one should the bot ever pick a move the rules refuse (the turn must go on).
function bot_move(state) {
    const move = choose_move(state);
    try {
        apply_move(state, state.players[state.current].handle, move);
        return move;
    } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        console.error(`The bot chose a move the rules refused (${e.code}); playing a random one instead.`);
        return random_move(state);
    }
}

/**
 * Plays the bot's turn at `room_id` if a bot is to move and has "thought" (bot_think_ms()), in one transaction with the
 * game locked, like a player's move. Returns whether it played.
 */
async function play_bot_turn(room_id, now = new Date()) {
    const played = await transaction(async function (client) {
        const {room, game} = await find_game(room_id, client);
        const player = game.players[game.current];
        if (game.winner !== null || !player.bot) return false;
        if (game.turn_started_at && Date.parse(game.turn_started_at) + bot_think_ms(room, game) > now.getTime()) return false;
        await play_turn({room, game, now, client, choose: bot_move});
        return true;
    });
    if (played) broadcast_game(room_id);
    return played;
}

/** Plays every bot turn that is due. Returns how many it played. */
async function play_bot_turns(now = new Date()) {
    let count = 0;
    for (const room_id of await db_game.bot_turns({started_before: new Date(now.getTime() - BOT_THINK_MS)})) {
        try {
            if (await play_bot_turn(room_id, now)) count++;
        } catch (e) {
            console.error(`Could not play the bot's turn at ${room_id}:`, e);
        }
    }
    return count;
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

// Runs `sweep()` every `interval_ms`, one at a time. Returns a function that stops it.
function every(interval_ms, sweep, label) {
    let running = false;
    const timer = setInterval(function () {
        if (running) return;
        running = true;
        sweep()
            .catch(function (e) {
                console.error(`${label} sweep failed:`, e.message);
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

/**
 * Checks for timed-out turns every `interval_ms`, one sweep at a time. Started by bin/www (not by the app, so
 * tests stay in control). Returns a function that stops it.
 */
function start_turn_timer({interval_ms = 1000} = {}) {
    return every(interval_ms, expire_overdue_turns, 'Turn timer');
}

/**
 * Lets the bots move, checking every `interval_ms` (a query each time, so no more often than the turn timer). Started
 * by bin/www, like the turn timer. Returns a stopper.
 */
function start_bot_players({interval_ms = 1000} = {}) {
    return every(interval_ms, play_bot_turns, 'Bot player');
}

module.exports = {
    start: handler(start),
    get: handler(get),
    turns: handler(turns),
    play,
    exchange,
    pass,
    forfeit: handler(forfeit),
    MISSED_TURNS_TO_FORFEIT,
    next_round,
    end_rounds,
    round_detail: handler(round_detail),
    expire_turn,
    expire_overdue_turns,
    start_turn_timer,
    deal_first_round,
    play_bot_turn,
    play_bot_turns,
    start_bot_players,
    BOT_THINK_MS,
    MATCH_START_GRACE_MS,
    presence_changed,
};
