// HTTP tests for the leaderboard: Elo ratings from won rounds, and the all-time, weekly and daily boards.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('leaderboard', function () {
    let database;
    let app;
    const agents = {};

    async function sign_up(handle) {
        agents[handle] = await verified_account(request, app, {username: handle, name: `P ${handle}`, email: `${handle}@example.test`});
    }

    // A started table with `handles` seated one per team, in order.
    async function started_table(handles) {
        const host = handles[0];
        const id = (await agents[host].post('/room/create')
            .send({number_of_team: handles.length, number_of_player_in_each_team: 1}).expect(200)).body.id;
        for (const [index, handle] of handles.entries()) {
            await agents[handle].post(`/room/${id}/join`).send({team_handle: `TEAM_${index + 1}`}).expect(200);
        }
        await agents[host].post(`/room/${id}/start`).expect(200);
        return id;
    }

    // Plays the winning move for whoever's turn it is (see the same helper in room.spec.js); resolves to their handle.
    async function win_round(id) {
        const games = require('../database/games');
        const state = await games.get({room_id: id});
        const player = state.players[state.current];
        const chips = state.chips.map(function (row) {
            return row.slice();
        });
        [1, 2, 3, 4].forEach(function (column) {
            chips[1][column] = player.team;
        });
        const sequence = {team: player.team, cells: [1, 2, 3, 4, 5].map(function (column) {
            chips[8][column] = player.team;
            return {row: 8, column};
        })};
        const hands = state.hands.slice();
        hands[state.current] = ['4-Spade'].concat(hands[state.current].slice(1));
        await games.save_state({room_id: id, state: Object.assign({}, state, {chips, hands, sequences: [sequence]})});
        await agents[player.handle].post(`/room/${id}/game/play`).send({hand_index: 0, row: 1, column: 5}).expect(200);
        return player.handle;
    }

    function board(handle, query = {}) {
        return agents[handle].get('/user/leaderboard').query(query);
    }

    beforeAll(async function () {
        database = await use_test_schema('leaderboard');
        app = require('../app');
        for (const handle of ['alice', 'bob', 'carol', 'dave']) await sign_up(handle);
    });

    afterAll(async function () {
        await database.drop();
    });

    test('needs a signed-in player and a known period', async function () {
        expect((await request(app).get('/user/leaderboard')).status).toBe(401);
        const response = await board('alice', {period: 'month'});
        expect([response.status, response.body.error]).toEqual([400, 'INVALID_PERIOD']);
    });

    test('is empty before any round is won', async function () {
        const {body} = await board('alice').expect(200);
        expect(body).toEqual({period: 'all', players: [], you: null, page: 1, per_page: 20, total: 0, pages: 1});
    });

    test('a won round rates both players, once, and ranks the winner first', async function () {
        const id = await started_table(['alice', 'bob']);
        const winner = await win_round(id);
        const loser = winner === 'alice' ? 'bob' : 'alice';

        const {body} = await board(loser).expect(200);
        expect(body.players).toEqual([
            {rank: 1, position: 1, handle: winner, name: `P ${winner}`, image: null, score: 1216, rating: 1216,
             rating_change: 16, played: 1, won: 1, lost: 0, win_rate: 1},
            {rank: 2, position: 2, handle: loser, name: `P ${loser}`, image: null, score: 1184, rating: 1184,
             rating_change: -16, played: 1, won: 0, lost: 1, win_rate: 0},
        ]);
        expect(body.you).toMatchObject({handle: loser, rank: 2, page: 1});
        expect(body.total).toBe(2);

        // Rating the same round again changes nothing.
        await database.pool.query('SELECT record_game_result(id) FROM games WHERE room_id = $1', [id]);
        expect((await board(loser)).body.players.map((p) => p.rating)).toEqual([1216, 1184]);

        // A player without a finished round isn't on the board, and is told so.
        expect((await board('dave')).body.you).toBeNull();
    });

    test('three teams: the winner beats both losers, each result counting half', async function () {
        const id = await started_table(['carol', 'dave', 'alice']);
        const {rows: [{rating: alice_before}]} = await database.pool.query(
            "SELECT rating FROM player_ratings JOIN users ON users.id = user_id WHERE handle = 'alice'");
        await database.pool.query(
            'UPDATE games SET winner_team = 0, finished_at = now() WHERE room_id = $1', [id]);
        await database.pool.query('SELECT record_game_result(id) FROM games WHERE room_id = $1', [id]);

        const {rows} = await database.pool.query(
            `SELECT users.handle, game_results.won, game_results.rating_change
             FROM game_results JOIN games ON games.id = game_id JOIN users ON users.id = game_results.user_id
             WHERE games.room_id = $1 ORDER BY game_results.team`, [id]);
        // The teams' average ratings were 1200, 1200 and alice's: carol is expected to beat dave by exactly half.
        const expected_vs_alice = 1 / (1 + Math.pow(10, (alice_before - 1200) / 400));
        expect(rows).toEqual([
            {handle: 'carol', won: true, rating_change: Math.round(16 * (0.5 + 1 - expected_vs_alice))},
            {handle: 'dave', won: false, rating_change: -8},
            {handle: 'alice', won: false, rating_change: Math.round(-16 * (1 - expected_vs_alice))},
        ]);
    });

    test('pages through the board and says which page the player is on', async function () {
        const {body: all} = await board('alice').expect(200);
        expect(all.total).toBe(4);
        const {body} = await board('alice', {per_page: 1, page: 2}).expect(200);
        expect(body).toMatchObject({page: 2, per_page: 1, total: 4, pages: 4});
        expect(body.players).toEqual([all.players[1]]);
        const you = all.players.find((p) => p.handle === 'alice');
        expect(body.you).toMatchObject({handle: 'alice', position: you.position, page: you.position});

        const past_end = (await board('alice', {per_page: 2, page: 9})).body;
        expect([past_end.players, past_end.total, past_end.pages]).toEqual([[], 4, 2]);
    });

    test('the weekly and daily boards rank by rating gained in their window', async function () {
        const {body: day} = await board('alice', {period: 'day'}).expect(200);
        expect(day.period).toBe('day');
        expect(day.total).toBe(4);
        expect(day.players.map((p) => p.score)).toEqual(day.players.map((p) => p.rating_change));
        expect(day.players.map((p) => p.score)).toEqual([...day.players.map((p) => p.score)].sort((a, b) => b - a));

        // Rounds from last week drop off the daily and weekly boards, but still count all time.
        await database.pool.query("UPDATE game_results SET finished_at = now() - interval '8 days'");
        expect((await board('alice', {period: 'week'})).body).toMatchObject({players: [], you: null, total: 0});
        expect((await board('alice', {period: 'day'})).body.total).toBe(0);
        expect((await board('alice', {period: 'all'})).body.total).toBe(4);

        await database.pool.query("UPDATE game_results SET finished_at = now() - interval '2 days'");
        expect((await board('alice', {period: 'week'})).body.total).toBe(4);
        expect((await board('alice', {period: 'day'})).body.total).toBe(0);
    });
});
