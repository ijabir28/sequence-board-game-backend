// HTTP tests for Quick Match: the queue, the tables it makes, the bots and the matchmaking leaderboard.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('quick match', function () {
    let database;
    let app;
    let matchmaking;
    let room_game;
    let games;
    const {BOT_AFTER_MS} = require('../entity/matchmaking');
    const agents = {};

    async function sign_up(handle) {
        agents[handle] = await verified_account(request, app, {username: handle, name: `P ${handle}`, email: `${handle}@example.test`});
    }

    function queue(handle, body) {
        return agents[handle].post('/matchmaking/queue').send(body);
    }

    // Runs `action` as if the clock read `at` (ms), for the queue's waiting times.
    async function at_time(at, action) {
        const spy = jest.spyOn(Date, 'now').mockReturnValue(at);
        try {
            return await action();
        } finally {
            spy.mockRestore();
        }
    }

    // Makes it the current player's turn with a winning move for them on (1, 5) (see the same helper in
    // leaderboard.spec.js); resolves to their handle.
    async function set_up_win(id) {
        const state = await games.get({room_id: id});
        const player = state.players[state.current];
        const chips = require('../entity/sequence_game').empty_chip_grid();
        [1, 2, 3, 4].forEach(function (column) {
            chips[1][column] = player.team;
        });
        const sequence = {team: player.team, cells: [1, 2, 3, 4, 5].map(function (column) {
            chips[8][column] = player.team;
            return {row: 8, column};
        })};
        const hands = state.hands.slice();
        hands[state.current] = ['4-Spade'].concat(hands[state.current].slice(1));
        // A three-team game is won with one sequence, so the row-8 one would already have won it.
        const sequences = state.team_count === 2 ? [sequence] : [];
        await games.save_state({room_id: id, state: Object.assign({}, state, {chips, hands, sequences})});
        return player;
    }

    // A clock that only moves on, an hour at a time, for moves made "later": each turn is stamped with the time it
    // was played, so the next one must come after it.
    let clock = Date.now();
    function later() {
        clock = Math.max(clock, Date.now()) + 3600000;
        return new Date(clock);
    }

    // Lets any bot whose turn it is move, as the bot sweeper would once it has "thought".
    function bots_move() {
        return room_game.play_bot_turns(later());
    }

    beforeAll(async function () {
        database = await use_test_schema('matchmaking');
        app = require('../app');
        matchmaking = require('./matchmaking');
        room_game = require('./room_game');
        games = require('../database/games');
        for (const handle of ['alice', 'bob', 'carol', 'dave', 'erin']) await sign_up(handle);
    });

    afterAll(async function () {
        await database.drop();
    });

    beforeEach(function () {
        matchmaking.reset();
    });

    test('needs a signed-in player and a table shape it offers', async function () {
        expect((await request(app).post('/matchmaking/queue').send({teams: 2, timer: 'blitz'})).status).toBe(401);
        expect((await request(app).get('/matchmaking/queue')).status).toBe(401);
        for (const body of [{teams: 4, timer: 'blitz'}, {teams: 2, timer: 'forever'}, {}]) {
            const response = await queue('alice', body);
            expect([response.status, response.body.error]).toEqual([400, 'INVALID_MATCH_SETTINGS']);
        }
        expect((await agents.alice.get('/matchmaking/queue').expect(200)).body).toEqual({status: 'idle'});
    });

    test('waits for an opponent, and leaving takes you out of the queue', async function () {
        const {body} = await queue('alice', {teams: 2, timer: 'slow'}).expect(200);
        expect(body).toEqual(expect.objectContaining({status: 'queued', teams: 2, timer: 'slow', turn_seconds: 90}));
        // Nothing says when bots would come, or how many others wait.
        expect(body.bots_at).toBeUndefined();
        expect(body.waiting).toBeUndefined();
        // Someone who wants a different table isn't matched with her.
        expect((await queue('bob', {teams: 2, timer: 'blitz'}).expect(200)).body.status).toBe('queued');
        expect((await agents.alice.delete('/matchmaking/queue').expect(200)).body).toEqual({status: 'idle'});
        expect((await agents.alice.get('/matchmaking/queue').expect(200)).body).toEqual({status: 'idle'});
    });

    test('seats two players who asked for the same table, one per team, and deals at once', async function () {
        await queue('alice', {teams: 2, timer: 'blitz'}).expect(200);
        const {body} = await queue('bob', {teams: 2, timer: 'blitz'}).expect(200);
        expect(body.status).toBe('matched');
        const id = body.room_id;
        expect((await agents.alice.get('/matchmaking/queue').expect(200)).body).toEqual({status: 'matched', room_id: id});

        const room = (await agents.alice.get(`/room/${id}`).expect(200)).body;
        expect(room).toEqual(expect.objectContaining({name: 'Quick Match · Blitz', game_started: true, round: 1}));
        expect(room.settings.turn_seconds).toBe(15);
        expect(room.teams.map(function (team) {
            return team.players.map(function (player) {
                return player.handle;
            });
        }).flat().sort()).toEqual(['alice', 'bob']);

        const game = (await agents.bob.get(`/room/${id}/game`).expect(200)).body;
        expect(game).toEqual(expect.objectContaining({matchmaking: true, turn_paused: false}));
        // The first turn gets extra time to open the game, and never waits for someone away.
        expect(Date.parse(game.turn_deadline) - Date.parse(game.turn_started_at)).toBe(15000 + room_game.MATCH_START_GRACE_MS);

        // Nobody can change seats or settings: the game has started.
        expect((await agents.carol.post(`/room/${id}/join`).send({team_handle: 'TEAM_1'})).body.message).toBe('GAME_ALREADY_STARTED');
        // While it is being played, the queue sends them back to it.
        expect((await queue('alice', {teams: 3, timer: 'slow'}).expect(200)).body).toEqual({status: 'playing', room_id: id});
    });

    test('fills the empty seats with bots after two minutes, and the bots play', async function () {
        const start = Date.now();
        await at_time(start, function () {
            return queue('carol', {teams: 3, timer: 'medium'}).expect(200);
        });
        await at_time(start + 1000, function () {
            return queue('dave', {teams: 3, timer: 'medium'}).expect(200);
        });
        // Both pages keep checking in while they wait.
        for (const handle of ['carol', 'dave']) {
            await at_time(start + BOT_AFTER_MS - 5000, function () {
                return agents[handle].get('/matchmaking/queue').expect(200);
            });
        }
        expect(await matchmaking.run_matches(start + BOT_AFTER_MS - 1)).toBe(0);
        expect(await matchmaking.run_matches(start + BOT_AFTER_MS)).toBe(1);

        const {room_id: id} = (await agents.carol.get('/matchmaking/queue').expect(200)).body;
        const bots = (await games.get({room_id: id})).players.filter(function (player) {
            return player.bot;
        });
        expect(bots).toHaveLength(1);
        // The bot passes for a player: an everyday handle, and nothing in the game or the room gives it away.
        expect(bots[0].handle).toMatch(/^[a-z0-9_]{3,20}$/);
        const game = (await agents.carol.get(`/room/${id}/game`).expect(200)).body;
        const room = (await agents.carol.get(`/room/${id}`).expect(200)).body;
        expect(JSON.stringify(game)).not.toMatch(/"bot"/);
        expect(JSON.stringify(room)).not.toMatch(/"bot"/);
        expect(game.players.map(function (player) {
            return player.handle;
        })).toContain(bots[0].handle);
        expect(game.away).not.toContain(bots[0].handle);

        // Play round the table: the bot moves for itself, people with a random legal card.
        const {legal_targets} = require('../entity/sequence_game');
        for (let turn = 0; turn < 6; turn++) {
            const state = await games.get({room_id: id});
            const player = state.players[state.current];
            if (player.bot) {
                expect(await bots_move()).toBe(1);
            } else {
                const hand_index = state.hands[state.current].findIndex(function (_, i) {
                    return legal_targets(state, i).length > 0;
                });
                const [target] = legal_targets(state, hand_index);
                await agents[player.handle].post(`/room/${id}/game/play`).send({hand_index, row: target.row, column: target.column}).expect(200);
            }
            expect((await games.get({room_id: id})).turn).toBe(state.turn + 1);
        }
        const turns = (await database.pool.query(
            `SELECT count(*)::INT AS n FROM turns JOIN users ON users.id = turns.user_id WHERE users.is_bot`
        )).rows[0].n;
        expect(turns).toBeGreaterThanOrEqual(2);
    });

    test('a won quick match ends the table and is rated on its own leaderboard only', async function () {
        const start = Date.now();
        await at_time(start, function () {
            return queue('erin', {teams: 2, timer: 'slow'}).expect(200);
        });
        await at_time(start + BOT_AFTER_MS - 1000, function () {
            return agents.erin.get('/matchmaking/queue').expect(200);
        });
        expect(await matchmaking.run_matches(start + BOT_AFTER_MS)).toBe(1);
        const {room_id: id} = (await agents.erin.get('/matchmaking/queue').expect(200)).body;

        // erin to move, with a winning card.
        let state = await games.get({room_id: id});
        if (state.players[state.current].bot) await bots_move();
        state = await games.get({room_id: id});
        expect(state.players[state.current].handle).toBe('erin');
        await set_up_win(id);
        const won = (await agents.erin.post(`/room/${id}/game/play`).send({hand_index: 0, row: 1, column: 5}).expect(200)).body;
        expect(won.winner).not.toBeNull();
        // One round only: the table's rounds are over at once, so there is nothing for a host to deal.
        expect(won.rounds).toEqual(expect.objectContaining({over: true}));
        expect((await agents.erin.post(`/room/${id}/rounds/next`)).body.error).toBe('ROUNDS_OVER');

        const board = (await agents.erin.get('/matchmaking/leaderboard').expect(200)).body;
        // The bot is rated (erin's win counts) but never listed.
        expect(board.players.map(function (player) {
            return player.handle;
        })).toEqual(['erin']);
        expect(board.you).toEqual(expect.objectContaining({handle: 'erin', played: 1, won: 1}));
        expect(board.you.rating).toBeGreaterThan(1200);
        // The private tables' leaderboard didn't move.
        const custom = (await agents.erin.get('/user/leaderboard').expect(200)).body;
        expect(custom.you).toBeNull();

        // erin is free to queue again.
        expect((await queue('erin', {teams: 2, timer: 'slow'}).expect(200)).body.status).toBe('queued');
    });

    // Seats `handles` at a quick match together at once; resolves to the table's code.
    async function people_match(handles, timer = 'slow') {
        let body;
        for (const handle of handles) body = (await queue(handle, {teams: handles.length, timer}).expect(200)).body;
        expect(body.status).toBe('matched');
        return body.room_id;
    }

    // Seats `handle` with bots, as after two minutes' wait; resolves to the table's code.
    async function bot_match(handle, teams = 2) {
        const start = Date.now();
        await at_time(start, function () {
            return queue(handle, {teams, timer: 'slow'}).expect(200);
        });
        await at_time(start + BOT_AFTER_MS - 1000, function () {
            return agents[handle].get('/matchmaking/queue').expect(200);
        });
        expect(await matchmaking.run_matches(start + BOT_AFTER_MS)).toBe(1);
        return (await agents[handle].get('/matchmaking/queue').expect(200)).body.room_id;
    }

    // Plays a legal card for the person to move (or lets the bot move) until `done(state)`.
    async function play_until(id, done) {
        const {legal_targets} = require('../entity/sequence_game');
        for (let moves = 0; moves < 20; moves++) {
            const state = await games.get({room_id: id});
            if (done(state)) return state;
            const player = state.players[state.current];
            if (player.bot) {
                await bots_move();
                continue;
            }
            const hand_index = state.hands[state.current].findIndex(function (_, i) {
                return legal_targets(state, i).length > 0;
            });
            const [target] = legal_targets(state, hand_index);
            await agents[player.handle].post(`/room/${id}/game/play`).send({hand_index, row: target.row, column: target.column}).expect(200);
        }
        throw new Error('the game never got there');
    }

    async function board_entry(handle) {
        return (await agents[handle].get('/matchmaking/leaderboard').expect(200)).body.you;
    }

    describe('forfeits', function () {
        beforeAll(async function () {
            for (const handle of ['fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee', 'max', 'nia']) await sign_up(handle);
        });

        test('with two teams, the other player wins and both are rated', async function () {
            const id = await people_match(['fay', 'gus']);
            const forfeited = (await agents.fay.post(`/room/${id}/game/forfeit`).expect(200)).body;
            expect(forfeited).toEqual(expect.objectContaining({forfeited: true, viewer: null, hand: []}));
            const seen = (await agents.gus.get(`/room/${id}/game`).expect(200)).body;
            expect(seen.players.find((p) => p.handle === 'gus').team).toBe(seen.winner);
            expect(seen.rounds.over).toBe(true);
            expect(seen.log.at(-2)).toEqual(expect.objectContaining({kind: 'forfeit', player: 'P fay', auto: false}));

            expect(await board_entry('gus')).toEqual(expect.objectContaining({played: 1, won: 1}));
            expect((await board_entry('gus')).rating).toBeGreaterThan(1200);
            expect(await board_entry('fay')).toEqual(expect.objectContaining({played: 1, won: 0}));
            expect((await board_entry('fay')).rating).toBeLessThan(1200);
            const {rows} = await database.pool.query(
                'SELECT users.handle, forfeit FROM matchmaking_results JOIN users ON users.id = user_id ORDER BY handle'
            );
            expect(rows.filter((row) => ['fay', 'gus'].includes(row.handle))).toEqual([
                {handle: 'fay', forfeit: true},
                {handle: 'gus', forfeit: false},
            ]);

            // Once is enough, and fay is free to queue again.
            expect((await agents.fay.post(`/room/${id}/game/forfeit`)).body.error).toBe('FORFEITED');
            expect((await queue('fay', {teams: 2, timer: 'blitz'}).expect(200)).body.status).toBe('queued');
            await agents.fay.delete('/matchmaking/queue').expect(200);
        });

        test('with three teams, a bot quietly plays the seat on; its win rates nobody', async function () {
            const id = await people_match(['hal', 'ivy', 'jon']);
            const before = (await agents.ivy.get(`/room/${id}/game`).expect(200)).body.players;
            await agents.hal.post(`/room/${id}/game/forfeit`).expect(200);

            // hal pays at once, and can't play the seat any more.
            expect(await board_entry('hal')).toEqual(expect.objectContaining({played: 1, won: 0}));
            expect((await board_entry('hal')).rating).toBeLessThan(1200);
            expect((await agents.hal.post(`/room/${id}/game/pass`)).body.error).toBe('FORFEITED');
            expect((await queue('hal', {teams: 2, timer: 'blitz'}).expect(200)).body.status).toBe('queued');
            await agents.hal.delete('/matchmaking/queue').expect(200);

            // The others see the same table as before: same names, nothing about a forfeit or a bot.
            const seen = (await agents.ivy.get(`/room/${id}/game`).expect(200)).body;
            expect(seen.players.map(({handle, name, team}) => ({handle, name, team})))
                .toEqual(before.map(({handle, name, team}) => ({handle, name, team})));
            expect(JSON.stringify(seen)).not.toMatch(/"kind":"forfeit"|"bot"|played_by/);
            const seat = (await games.get({room_id: id})).players.find((p) => p.handle === 'hal');
            expect(seat).toEqual(expect.objectContaining({bot: true, played_by: expect.any(String)}));

            // The bot finds the winning move for hal's seat.
            await play_until(id, (state) => state.players[state.current].handle === 'hal');
            await set_up_win(id);
            await bots_move();
            const over = await games.get({room_id: id});
            expect(over.players[over.winner].handle).toBe('hal');
            expect(await board_entry('ivy')).toBeNull();
            expect(await board_entry('jon')).toBeNull();
            expect(await board_entry('hal')).toEqual(expect.objectContaining({played: 1, won: 0}));
        });

        test('with three teams, a person who wins after a forfeit is rated as usual', async function () {
            const id = await people_match(['kim', 'lee', 'max']);
            await agents.max.post(`/room/${id}/game/forfeit`).expect(200);
            const penalty = (await board_entry('max')).rating_change;
            const state = await play_until(id, (s) => s.players[s.current].handle === 'kim');
            expect(state.players[state.current].handle).toBe('kim');
            await set_up_win(id);
            await agents.kim.post(`/room/${id}/game/play`).send({hand_index: 0, row: 1, column: 5}).expect(200);
            expect(await board_entry('kim')).toEqual(expect.objectContaining({played: 1, won: 1}));
            expect(await board_entry('lee')).toEqual(expect.objectContaining({played: 1, won: 0}));
            // max lost only what forfeiting cost.
            expect(await board_entry('max')).toEqual(expect.objectContaining({played: 1, won: 0, rating_change: penalty}));
        });

        test('missing ten turns in a row forfeits the match', async function () {
            const id = await bot_match('nia');
            let now = Date.now();
            let missed = 0;
            while (missed < room_game.MISSED_TURNS_TO_FORFEIT) {
                now += 120000;
                const state = await games.get({room_id: id});
                expect(state.winner).toBeNull();
                if (state.players[state.current].bot) {
                    expect(await room_game.play_bot_turns(new Date(now))).toBe(1);
                } else {
                    expect(await room_game.expire_turn(id, new Date(now))).toBe(true);
                    missed++;
                    if (missed < room_game.MISSED_TURNS_TO_FORFEIT) expect((await games.get({room_id: id})).missed.nia).toBe(missed);
                }
            }
            const over = (await agents.nia.get(`/room/${id}/game`).expect(200)).body;
            expect(over).toEqual(expect.objectContaining({forfeited: true}));
            expect(over.winner).not.toBeNull();
            expect(over.log.find((entry) => entry.kind === 'forfeit')).toEqual(expect.objectContaining({auto: true}));
            expect(await board_entry('nia')).toEqual(expect.objectContaining({played: 1, won: 0}));
        });

        test('a move of your own starts the count again, and private tables have no forfeit', async function () {
            const id = await bot_match('lee');
            const state = await play_until(id, (s) => !s.players[s.current].bot);
            await room_game.expire_turn(id, later());
            expect((await games.get({room_id: id})).missed.lee).toBe(1);
            await play_until(id, (s) => s.turn >= state.turn + 3);
            expect((await games.get({room_id: id})).missed.lee).toBe(0);

            const table = (await agents.lee.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1}).expect(200)).body.id;
            await agents.lee.post(`/room/${table}/join`).send({team_handle: 'TEAM_1'}).expect(200);
            await agents.kim.post(`/room/${table}/join`).send({team_handle: 'TEAM_2'}).expect(200);
            await agents.lee.post(`/room/${table}/start`).expect(200);
            expect((await agents.lee.post(`/room/${table}/game/forfeit`)).body.error).toBe('NOT_A_QUICK_MATCH');
        });
    });
});
