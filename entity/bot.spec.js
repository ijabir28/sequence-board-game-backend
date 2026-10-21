const {create_game, apply_move, random_move, empty_chip_grid} = require('./sequence_game');
const {choose_move, potential, WINDOWS} = require('./bot');

// A repeatable Math.random (mulberry32), so a failing game can be replayed.
function seeded(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function teams_of(team_count) {
    return Array.from({length: team_count}, function (_, t) {
        return {handle: `TEAM_${t + 1}`, players: [{handle: `p${t}`, name: `Player ${t}`, bot: t === 0}]};
    });
}

// A 2-team game where it is team 0's turn, with `chips` ([row, column, team]) on the board and `hand` in team 0's hand.
function position({chips = [], hand, sequences = [], team_count = 2, rules = {}, extra = {}}) {
    const game = create_game({teams: teams_of(team_count), rules, random: seeded(1)});
    const grid = empty_chip_grid();
    chips.forEach(function ([row, column, team]) {
        grid[row][column] = team;
    });
    const hands = game.hands.slice();
    hands[0] = hand;
    return Object.assign({}, game, {chips: grid, hands, current: 0, sequences}, extra);
}

function row_of(row, columns, team) {
    return columns.map(function (column) {
        return [row, column, team];
    });
}

// Board row 1: 5D 3H 2H 2S 3S 4S 5S 6S 7S AC. Row 8: 10S 10H QH KH AH 2C 3C 4C 5C 6C.
const QUIET_CARDS = ['9-Heart', 'K-Diamond', '8-Club'];

describe('the board windows', function () {
    test('are every 5-cell line on the board', function () {
        // 6 per row and per column, 36 per diagonal direction.
        expect(WINDOWS).toHaveLength(10 * 6 * 2 + 6 * 6 * 2);
    });

    test('are worth more the closer they are to a sequence, and nothing once another team blocks them', function () {
        const one = potential(position({chips: [[1, 3, 0]], hand: []}).chips, [], 0, 2);
        const two = potential(position({chips: [[1, 3, 0], [1, 4, 0]], hand: []}).chips, [], 0, 2);
        const blocked = potential(position({chips: [[1, 3, 0], [1, 4, 0], [1, 5, 1]], hand: []}).chips, [], 0, 2);
        expect(two).toBeGreaterThan(one);
        expect(blocked).toBeLessThan(two);
    });
});

describe('choose_move', function () {
    test('plays the winning move, with a plain card rather than a wild jack', function () {
        const sequence = {team: 0, cells: [1, 2, 3, 4, 5].map((column) => ({row: 8, column}))};
        const state = position({
            chips: row_of(8, [1, 2, 3, 4, 5], 0).concat(row_of(1, [1, 2, 3, 4], 0)),
            sequences: [sequence],
            hand: ['J-Club', '4-Spade'].concat(QUIET_CARDS),
        });
        const move = choose_move(state, seeded(2));
        expect(move).toEqual({type: 'play', hand_index: 1, target: {row: 1, column: 5}});
        expect(apply_move(state, 'p0', move).winner).toBe(0);
    });

    test("blocks an opponent's line that is one chip from a sequence", function () {
        const state = position({
            chips: [[1, 0, 0]].concat(row_of(1, [1, 2, 3, 4], 1)),
            hand: QUIET_CARDS.concat('4-Spade'),
        });
        expect(choose_move(state, seeded(3))).toEqual({type: 'play', hand_index: 3, target: {row: 1, column: 5}});
    });

    test("breaks an opponent's almost-sequence with a one-eyed jack when no card can block it", function () {
        const state = position({
            chips: [[1, 0, 0]].concat(row_of(1, [1, 2, 3, 4], 1)),
            hand: QUIET_CARDS.concat('J-Spade'),
        });
        const move = choose_move(state, seeded(4));
        expect(move.hand_index).toBe(3);
        expect(move.target.row).toBe(1);
        expect([1, 2, 3, 4]).toContain(move.target.column);
    });

    test('finishes a sequence with a wild jack', function () {
        const state = position({
            chips: [[1, 0, 1]].concat(row_of(1, [1, 2, 3, 4], 0)),
            hand: ['J-Diamond'].concat(QUIET_CARDS),
        });
        const move = choose_move(state, seeded(5));
        expect(move).toEqual({type: 'play', hand_index: 0, target: {row: 1, column: 5}});
        expect(apply_move(state, 'p0', move).sequences).toHaveLength(1);
    });

    test('keeps its jacks when a plain card does the job', function () {
        const state = position({hand: ['J-Club', 'J-Spade'].concat(QUIET_CARDS)});
        const move = choose_move(state, seeded(6));
        expect(move.type).toBe('play');
        expect(move.hand_index).toBeGreaterThanOrEqual(2);
    });

    test('exchanges a dead card first', function () {
        // Both 2-Spade cells, (1, 3) and (9, 8), are taken.
        const state = position({chips: [[1, 3, 1], [9, 8, 1]], hand: QUIET_CARDS.concat('2-Spade')});
        expect(choose_move(state, seeded(7))).toEqual({type: 'exchange', hand_index: 3});
    });

    test('passes when it can neither play nor exchange', function () {
        const chips = [];
        for (let row = 0; row < 10; row++) {
            for (let column = 0; column < 10; column++) chips.push([row, column, 1]);
        }
        const state = position({
            chips,
            hand: QUIET_CARDS.slice(),
            rules: {exchanges_per_turn: 1},
            extra: {exchanges_this_turn: 1},
        });
        expect(choose_move(state, seeded(8))).toEqual({type: 'pass'});
    });
});

// Plays a whole game, `players[team](state, random)` choosing each move. Resolves to the winning team.
function play_out(team_count, players, seed) {
    const random = seeded(seed);
    let state = create_game({teams: teams_of(team_count), random, first: seed % team_count});
    for (let moves = 0; moves < 2000 && state.winner === null; moves++) {
        const player = state.players[state.current];
        state = apply_move(state, player.handle, players[player.team](state, random), random);
    }
    return state.winner;
}

describe('a whole game', function () {
    test('the bot beats a player who moves at random, nearly every time', function () {
        let wins = 0;
        for (let seed = 1; seed <= 30; seed++) {
            if (play_out(2, [choose_move, random_move], seed) === 0) wins++;
        }
        expect(wins).toBeGreaterThanOrEqual(28);
    });

    test('bots playing each other always finish, with two or three teams', function () {
        for (let seed = 1; seed <= 6; seed++) {
            expect(play_out(2, [choose_move, choose_move], seed)).not.toBeNull();
            expect(play_out(3, [choose_move, choose_move, choose_move], seed)).not.toBeNull();
        }
    });
});
