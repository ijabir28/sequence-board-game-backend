const {round_stats, series_summary, seat_of_turn} = require('./rounds');
const {create_game, apply_move} = require('./sequence_game');

function teams_of(team_count, players_per_team) {
    return Array.from({length: team_count}, function (_, t) {
        return {
            handle: `TEAM_${t + 1}`,
            players: Array.from({length: players_per_team}, function (_, p) {
                return {handle: `t${t}p${p}`, name: `Player ${t}-${p}`};
            }),
        };
    });
}

/** The current player's first card becomes `card`. */
function with_card(state, card) {
    const hands = state.hands.map(function (h) {
        return h.slice();
    });
    hands[state.current][0] = card;
    return Object.assign({}, state, {hands});
}

function play(state, card, row, column) {
    const handle = state.players[state.current].handle;
    return apply_move(with_card(state, card), handle, {type: 'play', hand_index: 0, target: {row, column}});
}

describe('round_stats', function () {
    it('counts each player\'s cards, wild jacks and removals, and each team\'s chips and sequences', function () {
        let state = create_game({teams: teams_of(2, 1)});
        state = play(state, '6-Diamond', 0, 1);   // t0p0 places
        state = play(state, 'J-Club', 0, 2);      // t1p0 places with a wild jack
        state = play(state, '8-Diamond', 0, 3);   // t0p0 places
        state = play(state, 'J-Spade', 0, 1);     // t1p0 removes t0p0's chip
        const stats = round_stats(state);
        expect(stats).toMatchObject({winner: null, turns: 5, first_player: 't0p0'});
        expect(stats.players).toEqual([
            {handle: 't0p0', name: 'Player 0-0', team: 0, plays: 2, wilds: 0, removals: 0, exchanges: 0, passes: 0, timed_out: 0},
            {handle: 't1p0', name: 'Player 1-0', team: 1, plays: 2, wilds: 1, removals: 1, exchanges: 0, passes: 0, timed_out: 0},
        ]);
        expect(stats.teams).toEqual([
            {team: 0, sequences: 0, chips: 1, placed: 2, removed: 0},
            {team: 1, sequences: 0, chips: 1, placed: 1, removed: 1},
        ]);
    });

    it('credits moves to the right seat when the round did not start at seat 0', function () {
        const state = Object.assign(create_game({teams: teams_of(2, 2)}), {first: 3});
        expect([1, 2, 3, 4, 5].map(function (turn) {
            return seat_of_turn(state, turn);
        })).toEqual([3, 0, 1, 2, 3]);
        expect(round_stats(state).first_player).toBe(state.players[3].handle);
    });

    it('counts sequences, passes, exchanges and moves made for a player who timed out', function () {
        const state = create_game({teams: teams_of(2, 1)});
        const log = [
            {kind: 'place', turn: 1, player: 'Player 0-0', team: 0, card: '6-Diamond', pos: {row: 0, column: 1}, timed_out: true},
            {kind: 'exchange', turn: 2, player: 'Player 1-0', team: 1, card: '2-Club', auto: true},
            {kind: 'pass', turn: 2, player: 'Player 1-0', team: 1},
            {kind: 'sequence', turn: 3, team: 0, cells: []},
            {kind: 'win', turn: 3, team: 0},
        ];
        const stats = round_stats(Object.assign({}, state, {log, winner: 0, turn: 3}));
        expect(stats.winner).toBe(0);
        expect(stats.players[0]).toMatchObject({plays: 1, timed_out: 1});
        expect(stats.players[1]).toMatchObject({exchanges: 1, passes: 1, timed_out: 0});
        expect(stats.teams[0].sequences).toBe(1);
    });
});

describe('series_summary', function () {
    function round(winner, players) {
        return {
            winner,
            stats: {
                winner, turns: 10, first_player: 'a',
                teams: [{team: 0, sequences: winner === 0 ? 2 : 1, chips: 9, placed: 12, removed: 1},
                    {team: 1, sequences: winner === 1 ? 2 : 0, chips: 8, placed: 10, removed: 2}],
                players: players || [
                    {handle: 'a', name: 'A', team: 0, plays: 5, wilds: 1, removals: 1, exchanges: 0, passes: 0, timed_out: 0},
                    {handle: 'b', name: 'B', team: 1, plays: 5, wilds: 0, removals: 2, exchanges: 1, passes: 0, timed_out: 1},
                ],
            },
        };
    }

    it('adds up every round, and the team with the most round wins takes the series', function () {
        const summary = series_summary([round(0), round(1), round(0)], 2);
        expect(summary).toMatchObject({rounds_played: 3, turns: 30, verdict: {winner: 0, leaders: [0]}});
        expect(summary.teams).toEqual([
            {team: 0, rounds_won: 2, sequences: 5, placed: 36, removed: 3},
            {team: 1, rounds_won: 1, sequences: 2, placed: 30, removed: 6},
        ]);
        expect(summary.players).toEqual([
            {handle: 'a', name: 'A', team: 0, plays: 15, wilds: 3, removals: 3, exchanges: 0, passes: 0, timed_out: 0},
            {handle: 'b', name: 'B', team: 1, plays: 15, wilds: 0, removals: 6, exchanges: 3, passes: 0, timed_out: 3},
        ]);
    });

    it('is a draw when teams won as many rounds', function () {
        expect(series_summary([round(0), round(1)], 2).verdict).toEqual({winner: null, leaders: [0, 1]});
        expect(series_summary([round(1)], 3).verdict).toEqual({winner: 1, leaders: [1]});
    });

    it('counts a round won before statistics were kept for its winner only', function () {
        const summary = series_summary([{winner: 1, stats: null}, round(1)], 2);
        expect(summary.teams[1].rounds_won).toBe(2);
        expect(summary.turns).toBe(10);
    });
});
