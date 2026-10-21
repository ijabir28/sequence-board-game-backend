// The Quick Match queue: players ask for a table of a given shape and are seated with others who asked for the same.
// Pure (time is passed in), so it can be tested without a server; controller/matchmaking.js keeps the one queue the
// server has and makes the tables.
//
// A queue entry is one player waiting for one configuration: a team count (one player per team, so no one shares a
// team with a stranger) and a turn timer. As soon as enough players wait for the same configuration the oldest of
// them are matched. A player who has waited BOT_AFTER_MS is matched with whoever else is waiting and bots in the
// empty seats. A waiting page checks in every few seconds; an entry not seen for STALE_AFTER_MS (the page was
// closed) is dropped, so nobody is seated at a game they've left.

/** Turn timer choices, in seconds. */
const TIMERS = Object.freeze({blitz: 15, medium: 45, slow: 90});
const TEAM_COUNTS = Object.freeze([2, 3]);

/** How long a player waits for other people before bots fill the table. */
const BOT_AFTER_MS = 2 * 60 * 1000;
/** A waiting player who hasn't checked in for this long has gone. */
const STALE_AFTER_MS = 30 * 1000;

class MatchmakingError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'MatchmakingError';
        this.code = code;
    }
}

/** {teams, timer, turn_seconds} from a request body {teams, timer}. Throws INVALID_MATCH_SETTINGS. */
function parse_config(body = {}) {
    const teams = Number(body.teams);
    if (!TEAM_COUNTS.includes(teams)) {
        throw new MatchmakingError('INVALID_MATCH_SETTINGS', 'Choose 2 or 3 teams for a quick match.');
    }
    const timer = String(body.timer);
    if (!Object.prototype.hasOwnProperty.call(TIMERS, timer)) {
        throw new MatchmakingError('INVALID_MATCH_SETTINGS', 'Choose a turn timer: blitz (15 s), medium (45 s) or slow (90 s).');
    }
    return {teams, timer, turn_seconds: TIMERS[timer]};
}

function config_key(config) {
    return `${config.teams}:${config.timer}`;
}

/**
 * The waiting players, oldest first within each configuration. `join`, `leave` and `seen` change it; `take_matches`
 * removes the players it matches and returns them, so a player is only ever matched once.
 */
class MatchQueue {
    constructor() {
        // config key -> [entry], oldest first. An entry: {player: {user_id, handle, name}, config, joined_at, seen_at}.
        this.queues = new Map();
        // handle -> config key, for the players waiting.
        this.waiting = new Map();
    }

    /** Puts the player in the queue for `config` (out of any other they were in). Returns their entry. */
    join(player, config, now) {
        const current = this.entry(player.handle);
        if (current && config_key(current.config) === config_key(config)) {
            current.seen_at = now;
            return current;
        }
        this.leave(player.handle);
        const entry = {player, config, joined_at: now, seen_at: now};
        const key = config_key(config);
        if (!this.queues.has(key)) this.queues.set(key, []);
        this.queues.get(key).push(entry);
        this.waiting.set(player.handle, key);
        return entry;
    }

    /** Takes the player out of the queue. Returns whether they were in it. */
    leave(handle) {
        const key = this.waiting.get(handle);
        if (key === undefined) return false;
        this.waiting.delete(handle);
        const queue = this.queues.get(key).filter(function (entry) {
            return entry.player.handle !== handle;
        });
        if (queue.length === 0) this.queues.delete(key);
        else this.queues.set(key, queue);
        return true;
    }

    /** The player's entry, or undefined when they aren't waiting. */
    entry(handle) {
        const key = this.waiting.get(handle);
        if (key === undefined) return undefined;
        return this.queues.get(key).find(function (entry) {
            return entry.player.handle === handle;
        });
    }

    /** The waiting player checked in. Returns their entry, or undefined when they aren't waiting. */
    seen(handle, now) {
        const entry = this.entry(handle);
        if (entry) entry.seen_at = now;
        return entry;
    }

    /** How many players wait for the same configuration as `entry`, `entry` included. */
    waiting_with(entry) {
        const queue = this.queues.get(config_key(entry.config));
        return queue === undefined ? 0 : queue.length;
    }

    /** Puts matched players back at the front of their queue, as they were (making their table failed). */
    restore(entries) {
        entries.slice().reverse().forEach((entry) => {
            if (this.waiting.has(entry.player.handle)) return;
            const key = config_key(entry.config);
            if (!this.queues.has(key)) this.queues.set(key, []);
            this.queues.get(key).unshift(entry);
            this.waiting.set(entry.player.handle, key);
        });
    }

    /**
     * Drops the players who stopped checking in, then takes every table that can be made at `now`: full tables of
     * people first, then, for a queue whose oldest player has waited BOT_AFTER_MS, whoever waits with them. Returns
     * [{config, entries, bots}], `bots` being how many seats bots take.
     */
    take_matches(now) {
        const matches = [];
        Array.from(this.queues.values()).forEach((queue) => {
            queue.filter(function (entry) {
                return now - entry.seen_at > STALE_AFTER_MS;
            }).forEach((entry) => {
                this.leave(entry.player.handle);
            });
        });
        Array.from(this.queues.keys()).forEach((key) => {
            for (;;) {
                const queue = this.queues.get(key);
                if (queue === undefined) break;
                const {teams} = queue[0].config;
                const out_of_time = now - queue[0].joined_at >= BOT_AFTER_MS;
                if (queue.length < teams && !out_of_time) break;
                const entries = queue.slice(0, teams);
                entries.forEach((entry) => {
                    this.leave(entry.player.handle);
                });
                matches.push({config: entries[0].config, entries, bots: teams - entries.length});
            }
        });
        return matches;
    }
}

module.exports = {TIMERS, TEAM_COUNTS, BOT_AFTER_MS, STALE_AFTER_MS, MatchmakingError, MatchQueue, parse_config, config_key};
