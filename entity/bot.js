const {
    DIRECTIONS,
    card_kind,
    in_bounds,
    is_corner,
    can_exchange,
    is_dead_card,
    legal_targets,
    find_new_sequences,
    sequences_to_win,
} = require('./sequence_game');

// The bot that fills an empty seat at a matchmaking table. It looks one move ahead: every card in its hand on every
// cell it can go, scored by how the board looks afterwards.
//
// The board is read as its 5-cell windows (every place a sequence could still be made). A window is alive for a team
// while no other team has a chip in it; the more of the team's chips (corners count for everyone) it holds, the more it
// is worth, steeply, so a window one chip short of a sequence outweighs many with one or two. A move is worth what it
// adds to the bot's own windows (forming sequences) plus what it takes away from every opponent's (blocking theirs).
// Completing a sequence earns a bonus, and a winning move beats everything.
//
// Jacks cost something to play, so the bot keeps them for moves that matter: a wild jack to finish or nearly finish a
// sequence or to block one, a one-eyed jack to break an opponent's line that is about to become a sequence. A dead
// card is exchanged before anything else, since it is a free new card.
//
// Pure functions of the game state, like the rules engine, so they can be tested without a server.

const SEQUENCE_LENGTH = 5;

/** What an alive window is worth to a team, by how many of its cells count for that team (0 to 4). */
const WINDOW_VALUE = [0, 1, 4, 18, 90];
/** A window one chip short of the sequence that would win the game. */
const WINNING_THREAT_VALUE = 400;
/** Taking away from an opponent's windows weighs a little more than adding to the bot's own: block first. */
const DEFENSE_WEIGHT = 1.15;
const SEQUENCE_BONUS = 1500;
const WIN_SCORE = 1e9;
/** What playing a jack costs: it could have done something better later. */
const CARD_COST = {'two-eyed-jack': 45, 'one-eyed-jack': 35, normal: 0};
/** Breaks ties between equal moves at random, so the bot isn't predictable. */
const JITTER = 0.5;

// Every 5-cell line on the board: each one is a place a sequence could be made.
const WINDOWS = [];
for (let row = 0; row < 10; row++) {
    for (let column = 0; column < 10; column++) {
        DIRECTIONS.forEach(function (dir) {
            const cells = [];
            for (let i = 0; i < SEQUENCE_LENGTH; i++) cells.push({row: row + dir.row * i, column: column + dir.column * i});
            if (cells.every(in_bounds)) WINDOWS.push(cells);
        });
    }
}

function pos_key(pos) {
    return `${pos.row},${pos.column}`;
}

function team_sequences(sequences, team) {
    return sequences.filter(function (s) {
        return s.team === team;
    });
}

// The cells of a team's sequences: a new sequence may share at most one of them.
function claimed_cells(sequences, team) {
    const claimed = new Set();
    team_sequences(sequences, team).forEach(function (s) {
        s.cells.forEach(function (p) {
            claimed.add(pos_key(p));
        });
    });
    return claimed;
}

/** How good the board is for `team`: the sum of its alive windows' values. */
function potential(chips, sequences, team, team_count) {
    const claimed = claimed_cells(sequences, team);
    const one_from_win = sequences_to_win(team_count) - team_sequences(sequences, team).length === 1;
    let total = 0;
    for (const window of WINDOWS) {
        let own = 0;
        let shared = 0;
        let alive = true;
        for (const p of window) {
            const occupant = chips[p.row][p.column];
            if (is_corner(p) || occupant === team) {
                own++;
            } else if (occupant !== null) {
                alive = false;
                break;
            }
            if (claimed.has(pos_key(p))) shared++;
        }
        // A window already inside a sequence (or sharing two of its cells) can't make another one.
        if (!alive || shared > 1 || own >= SEQUENCE_LENGTH) continue;
        total += own === SEQUENCE_LENGTH - 1 && one_from_win ? WINNING_THREAT_VALUE : WINDOW_VALUE[own];
    }
    return total;
}

function opponents_of(state, team) {
    const teams = [];
    for (let t = 0; t < state.team_count; t++) if (t !== team) teams.push(t);
    return teams;
}

// The board's value for every team before the move, so each candidate only works out the after.
function baseline(state, team) {
    const opponents = opponents_of(state, team);
    return {
        team,
        opponents,
        own: potential(state.chips, state.sequences, team, state.team_count),
        theirs: opponents.map(function (t) {
            return potential(state.chips, state.sequences, t, state.team_count);
        }),
    };
}

/** How good it is for the current player to play `card` on `target` (a legal cell), before the card's cost. */
function score_play(state, base, card, target) {
    const {team, opponents} = base;
    const chips = state.chips.map(function (row) {
        return row.slice();
    });
    let sequences = state.sequences;
    let bonus = 0;

    if (card_kind(card) === 'one-eyed-jack') {
        chips[target.row][target.column] = null;
    } else {
        chips[target.row][target.column] = team;
        const found = find_new_sequences(chips, sequences, team, target);
        if (found.length > 0) {
            sequences = sequences.concat(found);
            if (team_sequences(sequences, team).length >= sequences_to_win(state.team_count)) return WIN_SCORE;
            bonus = SEQUENCE_BONUS * found.length;
        }
    }

    const attack = potential(chips, sequences, team, state.team_count) - base.own;
    const defense = opponents.reduce(function (sum, t, i) {
        return sum + base.theirs[i] - potential(chips, sequences, t, state.team_count);
    }, 0);
    return bonus + attack + DEFENSE_WEIGHT * defense;
}

/**
 * The bot's move for the current player of `state`, in the form apply_move() takes. A dead card is exchanged first
 * (the turn goes on, so ask again); otherwise the best play, or a pass when nothing can be played.
 */
function choose_move(state, random = Math.random) {
    const hand = state.hands[state.current];
    if (can_exchange(state)) {
        return {
            type: 'exchange',
            hand_index: hand.findIndex(function (card) {
                return is_dead_card(state, card);
            }),
        };
    }

    const base = baseline(state, state.players[state.current].team);
    const tried = new Set();
    let best = null;
    hand.forEach(function (card, hand_index) {
        // Two copies of a card have the same moves.
        if (tried.has(card)) return;
        tried.add(card);
        legal_targets(state, hand_index).forEach(function (target) {
            const score = score_play(state, base, card, target) - CARD_COST[card_kind(card)] + random() * JITTER;
            if (best === null || score > best.score) best = {score, hand_index, target};
        });
    });
    if (best === null) return {type: 'pass'};
    return {type: 'play', hand_index: best.hand_index, target: best.target};
}

module.exports = {WINDOWS, potential, score_play, choose_move};
