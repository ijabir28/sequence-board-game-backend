// Rules for a room (a table people sit at): its name, the slug that is its code, and its settings.
// Pure functions, so they can be tested without a database.

const NAME_MAX_LENGTH = 40;
const SLUG_BASE_MAX_LENGTH = 32;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ADJECTIVES = ['amber', 'brave', 'calm', 'clever', 'cosmic', 'golden', 'jolly', 'lucky', 'mellow', 'nimble', 'quiet', 'rapid', 'royal', 'swift', 'velvet', 'witty'];
const NOUNS = ['badger', 'comet', 'falcon', 'harbor', 'lantern', 'maple', 'meadow', 'otter', 'pebble', 'raven', 'river', 'summit', 'thistle', 'tiger', 'willow', 'zephyr'];

/**
 * How players find their dead cards. `manual`: nothing marks them; a player who spots one asks to exchange it, and
 * the server checks it really is dead. `indicator`: dead cards are marked in the hand (and can be auto-drawn).
 */
const DEAD_CARD_MODES = Object.freeze(['manual', 'indicator']);

/** Dead card exchanges a player may make in one turn: unlimited (null) or a number from 1 to this. */
const EXCHANGES_PER_TURN_MAX = 10;

/** Turn timer choices offered to hosts, in seconds. Any whole number of seconds in the allowed range also works. */
const TURN_TIMER_PRESETS = Object.freeze([30, 60, 90, 120, 180]);
const TURN_SECONDS_MIN = 15;
const TURN_SECONDS_MAX = 600;

/**
 * Blitz, a chess-style clock: each team has this long for the whole round, spent only while it is their turn. A team
 * whose clock runs out has a random card played for it at once on each of its turns. Hosts are offered 5 minutes; any
 * whole number of seconds in the allowed range also works.
 */
const BLITZ_CLOCK_SECONDS = 300;
const CLOCK_SECONDS_MIN = 60;
const CLOCK_SECONDS_MAX = 3600;

/** What a room does when its creator doesn't say otherwise. */
const DEFAULT_SETTINGS = Object.freeze({
    // Players can read every move so far (the move log and GET /room/:id/turns). Off unless the host turns it on.
    history: false,
    // Legal cells light up when a card is picked. Off unless the host turns it on.
    highlights: false,
    // A dead card is exchanged automatically at the start of its owner's turn (indicator mode only).
    auto_draw_dead: false,
    // Players spot dead cards themselves and ask to exchange them.
    dead_cards: 'manual',
    // Dead card exchanges per turn: null is unlimited.
    exchanges_per_turn: null,
    // How long each player has for a turn.
    turn_seconds: 90,
    // Blitz: each team's time for the whole round, in seconds, in place of the turn timer. Null is off.
    clock_seconds: null,
});

class RoomError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RoomError';
        this.code = code;
    }
}

function pick(list, random) {
    return list[Math.floor(random() * list.length)];
}

function capitalise(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A friendly name such as "Lucky Otter", for rooms created without one. */
function generate_name(random = Math.random) {
    return `${capitalise(pick(ADJECTIVES, random))} ${capitalise(pick(NOUNS, random))}`;
}

/** Trims and collapses spaces. Undefined, null or blank gives a generated name. Throws INVALID_NAME. */
function normalize_name(name, random = Math.random) {
    if (name === undefined || name === null || String(name).trim() === '') {
        return generate_name(random);
    }
    if (typeof name !== 'string') {
        throw new RoomError('INVALID_NAME', 'A table name must be text.');
    }
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (normalized.length > NAME_MAX_LENGTH) {
        throw new RoomError('INVALID_NAME', `A table name can be at most ${NAME_MAX_LENGTH} characters.`);
    }
    return normalized;
}

/** "Friday Night Café!" → "friday-night-cafe". Empty when nothing usable is left. */
function slugify(text) {
    return String(text)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_BASE_MAX_LENGTH)
        .replace(/-+$/, '');
}

/**
 * The room's code: the slug of its name plus a short random suffix, so two "Friday Night" tables get
 * different codes, e.g. "friday-night-k3m9".
 */
function generate_slug(name, random = Math.random) {
    const base = slugify(name) || 'table';
    let suffix = '';
    for (let i = 0; i < SLUG_SUFFIX_LENGTH; i++) {
        suffix += Math.floor(random() * 36).toString(36);
    }
    return `${base}-${suffix}`;
}

/** Room codes are slugs. Older rooms have numeric codes, which are slugs too. */
function is_slug(text) {
    return typeof text === 'string' && SLUG_PATTERN.test(text);
}

/**
 * Deals seated players out to seats at random, keeping teams as even as possible: seats are filled seat 0 of
 * every team, then seat 1 of every team, and so on. Returns [{team, seat, player}].
 */
function shuffle_seats(players, team_count, players_per_team, random = Math.random) {
    const shuffled = players.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    const seats = [];
    for (let seat = 0; seat < players_per_team; seat++) {
        for (let team = 0; team < team_count; team++) seats.push({team, seat});
    }
    return shuffled.slice(0, seats.length).map(function (player, i) {
        return Object.assign({player}, seats[i]);
    });
}

/**
 * Fits seated players into a resized table. A player whose seat still exists keeps it; the others move to the first
 * open seat on their own team, then to the first open seat anywhere (seat 0 of every team, then seat 1, ...). Those left
 * over have no seat. `seats` and the result are [{team, seat, player}], in seat order.
 */
function resize_seats(seats, team_count, players_per_team) {
    const ordered = seats.slice().sort(function (a, b) {
        return a.team - b.team || a.seat - b.seat;
    });
    const taken = new Set();
    const key = function (team, seat) {
        return `${team}:${seat}`;
    };
    const kept = [];
    const displaced = [];
    ordered.forEach(function (entry) {
        if (entry.team < team_count && entry.seat < players_per_team) {
            kept.push(entry);
            taken.add(key(entry.team, entry.seat));
        } else {
            displaced.push(entry);
        }
    });
    const open_seat = function (team) {
        for (let seat = 0; seat < players_per_team; seat++) {
            if (!taken.has(key(team, seat))) return seat;
        }
        return -1;
    };
    const moved = [];
    displaced.forEach(function ({team, player}) {
        let place = team < team_count && open_seat(team) >= 0 ? {team, seat: open_seat(team)} : null;
        for (let seat = 0; place === null && seat < players_per_team; seat++) {
            for (let other = 0; place === null && other < team_count; other++) {
                if (!taken.has(key(other, seat))) place = {team: other, seat};
            }
        }
        if (place === null) return;
        taken.add(key(place.team, place.seat));
        moved.push(Object.assign({player}, place));
    });
    return kept.concat(moved).sort(function (a, b) {
        return a.team - b.team || a.seat - b.seat;
    });
}

function parse_turn_seconds(value) {
    const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (Number.isInteger(seconds) && seconds >= TURN_SECONDS_MIN && seconds <= TURN_SECONDS_MAX) return seconds;
    throw new RoomError(
        'INVALID_SETTINGS',
        `The turn timer must be a whole number of seconds from ${TURN_SECONDS_MIN} to ${TURN_SECONDS_MAX}.`
    );
}

function parse_clock_seconds(value) {
    if (value === null || value === 'off') return null;
    const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (Number.isInteger(seconds) && seconds >= CLOCK_SECONDS_MIN && seconds <= CLOCK_SECONDS_MAX) return seconds;
    throw new RoomError(
        'INVALID_SETTINGS',
        `The blitz clock must be "off" or a whole number of seconds from ${CLOCK_SECONDS_MIN} to ${CLOCK_SECONDS_MAX}.`
    );
}

function parse_dead_cards(value) {
    if (DEAD_CARD_MODES.includes(value)) return value;
    throw new RoomError('INVALID_SETTINGS', `The setting "dead_cards" must be one of: ${DEAD_CARD_MODES.join(', ')}.`);
}

function parse_exchanges_per_turn(value) {
    if (value === null || value === 'unlimited') return null;
    const count = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (Number.isInteger(count) && count >= 1 && count <= EXCHANGES_PER_TURN_MAX) return count;
    throw new RoomError(
        'INVALID_SETTINGS',
        `Dead card exchanges per turn must be "unlimited" or a whole number from 1 to ${EXCHANGES_PER_TURN_MAX}.`
    );
}

const PARSERS = {
    turn_seconds: parse_turn_seconds,
    clock_seconds: parse_clock_seconds,
    dead_cards: parse_dead_cards,
    exchanges_per_turn: parse_exchanges_per_turn,
};

function parse_flag(value, key) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new RoomError('INVALID_SETTINGS', `The setting "${key}" must be true or false.`);
}

/**
 * Reads settings from a request body. Only keys in DEFAULT_SETTINGS are read; a missing key keeps the value
 * from `current` (the defaults for a new room). Throws INVALID_SETTINGS for an unknown dead card mode, a turn timer or blitz
 * clock out of range, or a flag that isn't a boolean.
 */
function parse_settings(body = {}, current = DEFAULT_SETTINGS) {
    const settings = Object.assign({}, current);
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        if (body[key] !== undefined) settings[key] = PARSERS[key] ? PARSERS[key](body[key]) : parse_flag(body[key], key);
    });
    return settings;
}

module.exports = {
    RoomError,
    DEFAULT_SETTINGS,
    DEAD_CARD_MODES,
    EXCHANGES_PER_TURN_MAX,
    TURN_TIMER_PRESETS,
    TURN_SECONDS_MIN,
    TURN_SECONDS_MAX,
    BLITZ_CLOCK_SECONDS,
    CLOCK_SECONDS_MIN,
    CLOCK_SECONDS_MAX,
    NAME_MAX_LENGTH,
    generate_name,
    normalize_name,
    slugify,
    generate_slug,
    is_slug,
    parse_settings,
    shuffle_seats,
    resize_seats,
};
