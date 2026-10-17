// A table's game is played in rounds (see docs/architecture.md). This file sums up a round from its final state,
// and a whole series of rounds into a final result. Pure functions, so they can be tested without a database.

// The seat that moved first in the round. Games stored before rounds always started with seat 0.
function first_seat(state) {
    return Number.isInteger(state.first) ? state.first : 0;
}

// Who played turn `turn`: turns go round the seats in order from the first one, and an exchange keeps the turn, so
// a log entry's turn says whose it was (an auto-drawn dead card too, which is logged for the player whose turn starts).
function seat_of_turn(state, turn) {
    return (first_seat(state) + turn - 1) % state.players.length;
}

function empty_player(player) {
    return {handle: player.handle, name: player.name, team: player.team, plays: 0, wilds: 0, removals: 0, exchanges: 0, passes: 0, timed_out: 0};
}

function empty_team(team) {
    return {team, sequences: 0, chips: 0, placed: 0, removed: 0};
}

/**
 * How one round went, from its final state (the full log, whatever the room's history setting):
 * {winner, turns, first_player, teams: [{team, sequences, chips, placed, removed}],
 *  players: [{handle, name, team, plays, wilds, removals, exchanges, passes, timed_out}]}.
 * `chips` are the team's chips on the board at the end, `placed` the chips it put down (wild jacks included) and
 * `removed` the opponents' chips it took off with one-eyed jacks. A player's `plays` are the cards they played
 * (placed or removed a chip); `timed_out` counts the moves made for them when their turn timer ran out.
 */
function round_stats(state) {
    const players = state.players.map(empty_player);
    const teams = Array.from({length: state.team_count}, function (_, team) {
        return empty_team(team);
    });
    state.log.forEach(function (entry) {
        const player = players[seat_of_turn(state, entry.turn)];
        const team = teams[entry.team];
        if (entry.timed_out && ['place', 'remove', 'exchange', 'pass'].includes(entry.kind)) player.timed_out++;
        switch (entry.kind) {
            case 'place':
                player.plays++;
                team.placed++;
                if (entry.wild) player.wilds++;
                break;
            case 'remove':
                player.plays++;
                player.removals++;
                team.removed++;
                break;
            case 'exchange':
                player.exchanges++;
                break;
            case 'pass':
                player.passes++;
                break;
            case 'sequence':
                team.sequences++;
                break;
        }
    });
    state.chips.forEach(function (row) {
        row.forEach(function (chip) {
            if (chip !== null) teams[chip].chips++;
        });
    });
    return {
        winner: state.winner,
        turns: state.turn,
        first_player: state.players[first_seat(state)].handle,
        teams,
        players,
    };
}

const PLAYER_TOTALS = ['plays', 'wilds', 'removals', 'exchanges', 'passes', 'timed_out'];
const TEAM_TOTALS = ['sequences', 'placed', 'removed'];

/**
 * The final result of a table's rounds, from the won rounds in order ([{round, winner, stats}], `stats` from
 * round_stats() or null for a round won before statistics were kept):
 * {rounds_played, turns, teams: [{team, rounds_won, sequences, placed, removed}], players: [...summed per player],
 *  verdict: {winner, leaders}}. The team that won the most rounds wins the series; `leaders` lists every team with
 * that many wins, so more than one means a draw (and `winner` is null).
 */
function series_summary(rounds, team_count) {
    const teams = Array.from({length: team_count}, function (_, team) {
        return {team, rounds_won: 0, sequences: 0, placed: 0, removed: 0};
    });
    const players = new Map();
    let turns = 0;
    rounds.forEach(function ({winner, stats}) {
        if (winner !== null && teams[winner]) teams[winner].rounds_won++;
        if (!stats) return;
        turns += stats.turns;
        stats.teams.forEach(function (round_team) {
            TEAM_TOTALS.forEach(function (key) {
                teams[round_team.team][key] += round_team[key];
            });
        });
        stats.players.forEach(function (round_player) {
            if (!players.has(round_player.handle)) players.set(round_player.handle, empty_player(round_player));
            const total = players.get(round_player.handle);
            // The latest round's name, in case a player renamed themselves between rounds.
            total.name = round_player.name;
            PLAYER_TOTALS.forEach(function (key) {
                total[key] += round_player[key];
            });
        });
    });
    const most = Math.max(...teams.map(function (team) {
        return team.rounds_won;
    }));
    const leaders = teams.filter(function (team) {
        return team.rounds_won === most;
    }).map(function (team) {
        return team.team;
    });
    return {
        rounds_played: rounds.length,
        turns,
        teams,
        players: Array.from(players.values()),
        verdict: {winner: leaders.length === 1 ? leaders[0] : null, leaders},
    };
}

module.exports = {round_stats, series_summary, seat_of_turn, first_seat};
