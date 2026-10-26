const {SERVER_ERROR_MESSAGE} = require('./errors');
const db_room = require('../database/rooms');
const db_user = require('../database/users');
const {transaction} = require('../database/pool');
const {DEFAULT_SETTINGS, generate_slug} = require('../entity/room');
const {MatchQueue, MatchmakingError, parse_config} = require('../entity/matchmaking');
const {deal_first_round} = require('./room_game');
const {broadcast_room} = require('./room');
const socket_server = require('../socket');

// Quick Match: players queue for a table shape (2 or 3 teams of one, and a turn timer) and the server seats them
// with others who asked for the same, or with bots once they've waited two minutes (entity/matchmaking.js). The
// table is dealt straight away and plays one round, rated on the matchmaking leaderboard. Errors are JSON:
// {error: CODE, message}.
//
// Bots pass for players: nothing a client is sent says a seat is a bot's or when bots would be brought in (no bot
// time, no count of who else is waiting), and a match is announced with every seat's handle alike.
//
// The queue is in memory, so a restart empties it; waiting pages see they're no longer queued and queue again.

const queue = new MatchQueue();
// handle -> {room_id, at}: where a matched player was seated, until their page has asked (or a few minutes pass).
const matched = new Map();
const MATCHED_KEPT_MS = 5 * 60 * 1000;
// Handles of matched players whose table is being made: neither waiting nor seated yet, and not to be queued again.
const pending = new Set();

const TIMER_NAMES = {fast: 'Fast', medium: 'Medium', slow: 'Slow'};

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
};

async function signed_in_player(req) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) throw new MatchmakingError('NOT_SIGNED_IN', 'Sign in to play a quick match.');
    return {user_id: user.id, handle: user.handle, name: user.name};
}

function shuffled(items, random = Math.random) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * Makes the table for a match from the queue: one seat per team, in random order, bots in the seats nobody took;
 * then deals its round. Resolves to the table's code.
 */
async function create_match(match) {
    const {config, entries, bots} = match;
    const bot_players = bots > 0 ? await db_user.random_bots({count: bots}) : [];
    if (bot_players.length < bots) throw new Error(`Only ${bot_players.length} bots for ${bots} seats.`);
    const players = shuffled(entries.map(function (entry) {
        return entry.player;
    }).concat(bot_players));
    match.handles = players.map(function (player) {
        return player.handle;
    });
    const name = `Quick Match · ${TIMER_NAMES[config.timer]}`;
    const id = await db_room.create({
        make_id: function () {
            return generate_slug('quick match');
        },
        name,
        administrator_id: entries[0].player.user_id,
        team_count: config.teams,
        players_per_team: 1,
        settings: Object.assign({}, DEFAULT_SETTINGS, {turn_seconds: config.turn_seconds}),
        matchmaking: true,
    });
    await transaction(async function (client) {
        await db_room.get({id, client, lock: true});
        await db_room.reseat({
            id,
            seats: players.map(function (player, team) {
                return {team, seat: 0, user_id: player.user_id};
            }),
            client,
        });
        await deal_first_round(await db_room.get({id, client}), client);
    });
    return id;
}

/** Makes every table the queue can make at `now`. A table that fails puts its players back in the queue. */
async function run_matches(now = Date.now()) {
    for (const [handle, {at}] of matched) {
        if (now - at > MATCHED_KEPT_MS) matched.delete(handle);
    }
    let made = 0;
    for (const match of queue.take_matches(now)) {
        const handles = match.entries.map(function (entry) {
            return entry.player.handle;
        });
        handles.forEach(function (handle) {
            pending.add(handle);
        });
        try {
            const room_id = await create_match(match);
            handles.forEach(function (handle) {
                matched.set(handle, {room_id, at: now});
            });
            made++;
            socket_server.broadcast({event: 'match_found', data: {room_id, players: match.handles}});
            await broadcast_room({id: room_id});
        } catch (e) {
            console.error('Could not make a quick match table:', e);
            queue.restore(match.entries);
        } finally {
            handles.forEach(function (handle) {
                pending.delete(handle);
            });
        }
    }
    return made;
}

/** Where the player stands: waiting (and for what), just seated at a table, or neither. */
async function status_of(player, now) {
    const entry = queue.entry(player.handle);
    if (entry) {
        return {
            status: 'queued',
            teams: entry.config.teams,
            timer: entry.config.timer,
            turn_seconds: entry.config.turn_seconds,
            joined_at: new Date(entry.joined_at).toISOString(),
            server_time: new Date(now).toISOString(),
        };
    }
    if (pending.has(player.handle)) return {status: 'matching'};
    const seated = matched.get(player.handle);
    if (seated) return {status: 'matched', room_id: seated.room_id};
    // A game they are already playing, e.g. after closing the tab: back to it rather than into another.
    const playing = await db_room.current_match_for_user({user_id: player.user_id});
    if (playing !== undefined) return {status: 'playing', room_id: playing};
    return {status: 'idle'};
}

/**
 * POST /matchmaking/queue {teams: 2|3, timer: fast|medium|slow}: joins the queue (or moves to that configuration).
 * Answers with the status: `queued`, or `matched` when the table was made at once, or `playing` (and not queued) for
 * a player who already has a quick match in progress, or `matching` while their table is being made.
 */
async function join(req, res) {
    const player = await signed_in_player(req);
    const config = parse_config(req.body || {});
    if (pending.has(player.handle)) return res.send({status: 'matching'});
    const playing = await db_room.current_match_for_user({user_id: player.user_id});
    if (playing !== undefined) return res.send({status: 'playing', room_id: playing});
    matched.delete(player.handle);
    const now = Date.now();
    queue.join(player, config, now);
    await run_matches(now);
    res.send(await status_of(player, now));
}

/** GET /matchmaking/queue: the status, see join(). A waiting page calls it every few seconds to stay in the queue. */
async function status(req, res) {
    const player = await signed_in_player(req);
    const now = Date.now();
    queue.seen(player.handle, now);
    res.send(await status_of(player, now));
}

/** DELETE /matchmaking/queue: leaves the queue. 200 with the status. */
async function leave(req, res) {
    const player = await signed_in_player(req);
    queue.leave(player.handle);
    matched.delete(player.handle);
    res.send(await status_of(player, Date.now()));
}

/**
 * Makes the tables whose waiting players have run out of patience (bots join them), and drops players who stopped
 * checking in, every `interval_ms`. Started by bin/www. Returns a function that stops it.
 */
function start_matchmaking({interval_ms = 1000} = {}) {
    let running = false;
    const timer = setInterval(function () {
        if (running) return;
        running = true;
        run_matches()
            .catch(function (e) {
                console.error('Matchmaking sweep failed:', e.message);
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

/** Empties the queue (for tests). */
function reset() {
    queue.queues.clear();
    queue.waiting.clear();
    matched.clear();
    pending.clear();
}

// Express 4 doesn't catch rejected promises, so every handler reports its own errors.
function handler(action) {
    return function (req, res) {
        action(req, res).catch(function (e) {
            if (res.headersSent) return console.error(e);
            if (e instanceof MatchmakingError) {
                return res.status(STATUS_BY_ERROR[e.code] || 400).send({error: e.code, message: e.message});
            }
            console.error(e);
            res.status(500).send({error: 'SERVER_ERROR', message: SERVER_ERROR_MESSAGE});
        });
    };
}

module.exports = {
    join: handler(join),
    status: handler(status),
    leave: handler(leave),
    run_matches,
    start_matchmaking,
    reset,
};
