// HTTP tests for rooms and table games. Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {ORIGIN, verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('rooms and table games', function () {
    let database;
    let app;
    // The same copies of the modules the app uses (a test below reloads every module to simulate a restart).
    let presence;
    let room_game_module;
    const agents = {};

    // These players have the table's game open in a browser.
    function at_table(id, ...handles) {
        handles.forEach(function (handle) {
            presence.arrive({room_id: id, handle, connection: `test-${handle}`});
        });
    }

    async function sign_up(handle) {
        agents[handle] = await verified_account(request, app, {username: handle, name: `P ${handle}`, email: `${handle}@example.test`});
    }

    async function open_room(handle, teams = 2, players = 1, settings = {}) {
        const response = await agents[handle].post('/room/create')
            .send(Object.assign({number_of_team: teams, number_of_player_in_each_team: players}, settings)).expect(200);
        return response.body.id;
    }

    function join(handle, id, team_handle) {
        return agents[handle].post(`/room/${id}/join`).send({team_handle}).then(function (response) {
            return response.body.message;
        });
    }

    // A legal move for whoever's turn it is, found with the rules engine from the stored game.
    async function legal_play(id) {
        const {legal_targets} = require('../entity/sequence_game');
        const state = await require('../database/games').get({room_id: id});
        const player = state.players[state.current];
        for (let hand_index = 0; hand_index < state.hands[state.current].length; hand_index++) {
            const [target] = legal_targets(state, hand_index);
            if (target) return {handle: player.handle, body: {hand_index, row: target.row, column: target.column}};
        }
        throw new Error('no legal play in this deal');
    }

    beforeAll(async function () {
        database = await use_test_schema('room');
        app = require('../app');
        presence = require('./presence');
        room_game_module = require('./room_game');
        for (const handle of ['alice', 'bob', 'carol', 'dave']) await sign_up(handle);
    });

    afterAll(async function () {
        // The restart test loads a second copy of the app, with its own pool.
        const current = require('../database/pool').pool;
        if (current !== database.pool) await current.end();
        await database.drop();
    });

    describe('POST /room/create', function () {
        test('needs a signed-in user', async function () {
            const response = await request(app).post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('NOT_SIGNED_IN');
        });

        test('refuses table sizes the rules cannot deal for', async function () {
            for (const [teams, players] of [[4, 1], [2, 0], [3, 5], ['x', 1]]) {
                const response = await agents.alice.post('/room/create')
                    .send({number_of_team: teams, number_of_player_in_each_team: players});
                expect(response.status).toBe(400);
                expect(response.body.error).toBe('UNSUPPORTED_TABLE');
            }
        });

        test('stores the room with empty seats', async function () {
            const id = await open_room('alice', 3, 2);
            const room = (await request(app).get(`/room/${id}`)).body;
            expect(room).toMatchObject({id, administrator: 'alice', game_started: false});
            expect(room.teams).toEqual([
                {handle: 'TEAM_1', players: [null, null]},
                {handle: 'TEAM_2', players: [null, null]},
                {handle: 'TEAM_3', players: [null, null]},
            ]);
        });
    });

    describe('names, slugs and settings', function () {
        test('the code is a slug of the name, and settings default sensibly', async function () {
            const response = await agents.alice.post('/room/create')
                .send({number_of_team: 2, number_of_player_in_each_team: 1, name: '  Friday   Night Café '}).expect(200);
            expect(response.body.id).toMatch(/^friday-night-cafe-[a-z0-9]{4}$/);
            const room = (await request(app).get(`/room/${response.body.id}`)).body;
            expect(room.name).toBe('Friday Night Café');
            expect(room.settings).toEqual({
                mode: 'standard', history: false, highlights: false, auto_draw_dead: false, turn_seconds: 90,
                dead_cards: 'manual', exchanges_per_turn: null,
            });
        });

        test('a table without a name gets a generated one', async function () {
            const id = await open_room('alice');
            const room = (await request(app).get(`/room/${id}`)).body;
            expect(room.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
            expect(id.startsWith(room.name.toLowerCase().replace(' ', '-') + '-')).toBe(true);
        });

        test('two tables with the same name get different codes', async function () {
            const ids = await Promise.all([1, 2, 3].map(function () {
                return agents.alice.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1, name: 'Same'})
                    .then(function (response) {
                        return response.body.id;
                    });
            }));
            expect(new Set(ids).size).toBe(3);
        });

        test('settings chosen at creation are stored', async function () {
            const response = await agents.alice.post('/room/create').send({
                number_of_team: 2, number_of_player_in_each_team: 1, mode: 'training', history: false, highlights: 'false', auto_draw_dead: true,
            }).expect(200);
            const room = (await request(app).get(`/room/${response.body.id}`)).body;
            expect(room.settings).toEqual({
                mode: 'training', history: false, highlights: false, auto_draw_dead: true, turn_seconds: 90,
                dead_cards: 'manual', exchanges_per_turn: null,
            });
            const bad = await agents.alice.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1, mode: 'easy'});
            expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_SETTINGS']);

            const custom = await agents.alice.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1, turn_seconds: 45});
            expect((await request(app).get(`/room/${custom.body.id}`)).body.settings.turn_seconds).toBe(45);
            const too_short = await agents.alice.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1, turn_seconds: 5});
            expect([too_short.status, too_short.body.error]).toEqual([400, 'INVALID_SETTINGS']);
        });

        test('refuses a bad name or setting', async function () {
            const base = {number_of_team: 2, number_of_player_in_each_team: 1};
            const long = await agents.alice.post('/room/create').send(Object.assign({name: 'x'.repeat(41)}, base));
            expect([long.status, long.body.error]).toEqual([400, 'INVALID_NAME']);
            const bad = await agents.alice.post('/room/create').send(Object.assign({history: 'maybe'}, base));
            expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_SETTINGS']);
        });

        test('only the host changes settings, and only before the game starts', async function () {
            const id = await open_room('alice');
            const changed = await agents.alice.patch(`/room/${id}/settings`).send({name: 'Renamed', highlights: true});
            expect(changed.status).toBe(200);
            expect(changed.body).toMatchObject({id, name: 'Renamed', settings: {history: false, highlights: true, auto_draw_dead: false}});

            expect((await agents.bob.patch(`/room/${id}/settings`).send({history: false})).body.error).toBe('NOT_HOST');
            expect((await request(app).patch(`/room/${id}/settings`).send({history: false})).status).toBe(401);
            expect((await agents.alice.patch('/room/nope/settings').send({})).status).toBe(404);
            expect((await agents.alice.patch(`/room/${id}/settings`).send({history: 1})).body.error).toBe('INVALID_SETTINGS');

            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            await agents.alice.post(`/room/${id}/start`).expect(200);
            const late = await agents.alice.patch(`/room/${id}/settings`).send({history: false});
            expect([late.status, late.body.error]).toEqual([409, 'GAME_ALREADY_STARTED']);
        });
    });

    test('GET /room/:id of an unknown id is an empty 200, as before', async function () {
        const response = await request(app).get('/room/does-not-exist');
        expect(response.status).toBe(200);
        expect(response.text).toBe('');
    });

    describe('POST /room/:id/join', function () {
        test('seats players and reports every refusal', async function () {
            const id = await open_room('alice', 2, 1);
            expect(await join('alice', id, 'TEAM_1')).toBe('success');
            expect(await join('alice', id, 'TEAM_2')).toBe('ALREADY_SEATED');
            expect(await join('bob', id, 'TEAM_1')).toBe('SEAT_TAKEN');
            expect(await join('bob', id, 'TEAM_9')).toBe('TEAM_NOT_FOUND');
            expect(await join('bob', 'nope', 'TEAM_1')).toBe('ROOM_NOT_FOUND');
            expect((await request(app).post(`/room/${id}/join`).send({team_handle: 'TEAM_2'})).body.message).toBe('NOT_SIGNED_IN');

            const room = (await request(app).get(`/room/${id}`)).body;
            expect(room.teams[0].players).toEqual([{handle: 'alice', name: 'P alice'}]);
        });

        test('a player can stand up and take another seat until the game starts', async function () {
            const id = await open_room('alice', 2, 1);
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');

            const left = await agents.alice.post(`/room/${id}/leave`);
            expect(left.status).toBe(200);
            expect(left.body.teams.map(function (t) {
                return t.players;
            })).toEqual([[null], [{handle: 'bob', name: 'P bob'}]]);
            // The freed seat can be taken by anyone, including the player who left.
            expect(await join('carol', id, 'TEAM_1')).toBe('success');
            await agents.carol.post(`/room/${id}/leave`).expect(200);
            expect(await join('alice', id, 'TEAM_1')).toBe('success');

            const twice = await agents.dave.post(`/room/${id}/leave`);
            expect([twice.status, twice.body.error]).toEqual([409, 'NOT_SEATED']);
            expect((await request(app).post(`/room/${id}/leave`)).status).toBe(401);
            expect((await agents.alice.post('/room/nope/leave')).status).toBe(404);

            await agents.alice.post(`/room/${id}/start`).expect(200);
            const late = await agents.bob.post(`/room/${id}/leave`);
            expect([late.status, late.body.error]).toEqual([409, 'GAME_ALREADY_STARTED']);
        });

        test('the host can shuffle seated players across the teams', async function () {
            const id = await open_room('alice', 2, 2);
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_1');
            await join('carol', id, 'TEAM_2');

            const socket_server = require('../socket');
            const sent = jest.spyOn(socket_server, 'broadcast');
            const shuffled = await agents.alice.post(`/room/${id}/shuffle`);
            expect(shuffled.status).toBe(200);
            const event = sent.mock.calls.map(function ([call]) {
                return call;
            }).find(function (call) {
                return call.event === 'teams_shuffled';
            });
            // As clients receive it: JSON, so dates are strings like in the HTTP response.
            expect(JSON.parse(JSON.stringify(event.data))).toEqual({room_id: id, by: {handle: 'alice', name: 'P alice'}, room: shuffled.body});
            sent.mockRestore();
            const players = shuffled.body.teams.flatMap(function (t) {
                return t.players;
            }).filter(Boolean).map(function (p) {
                return p.handle;
            });
            expect(players.sort()).toEqual(['alice', 'bob', 'carol']);
            // Three players on two teams of two: each team gets at least one.
            expect(shuffled.body.teams.every(function (t) {
                return t.players[0] !== null;
            })).toBe(true);
            expect(JSON.stringify(shuffled.body)).not.toMatch(/user_id/);

            const guest = await agents.bob.post(`/room/${id}/shuffle`);
            expect([guest.status, guest.body.error]).toEqual([403, 'NOT_HOST']);
            await join('dave', id, shuffled.body.teams.find(function (t) {
                return t.players.includes(null);
            }).handle);
            await agents.alice.post(`/room/${id}/start`).expect(200);
            expect((await agents.alice.post(`/room/${id}/shuffle`)).body.error).toBe('GAME_ALREADY_STARTED');
        });

        test('gives a contested last seat to exactly one player', async function () {
            const id = await open_room('alice', 2, 1);
            await join('alice', id, 'TEAM_1');
            const results = await Promise.all(['bob', 'carol', 'dave'].map(function (handle) {
                return join(handle, id, 'TEAM_2');
            }));
            expect(results.sort()).toEqual(['SEAT_TAKEN', 'SEAT_TAKEN', 'success']);
        });
    });

    describe('table game', function () {
        test('starts a full table, then plays moves in turn', async function () {
            const id = await open_room('alice', 2, 1);
            await join('alice', id, 'TEAM_1');
            expect((await agents.alice.post(`/room/${id}/start`)).body.error).toBe('TABLE_NOT_FULL');
            await join('bob', id, 'TEAM_2');
            expect((await agents.carol.post(`/room/${id}/start`)).body.error).toBe('NOT_HOST');
            const seated_guest = await agents.bob.post(`/room/${id}/start`);
            expect([seated_guest.status, seated_guest.body.error]).toEqual([403, 'NOT_HOST']);
            // Players are addressed by their display name, not their handle.
            expect(seated_guest.body.message).toBe('Only P alice, who opened this table, can start its game.');
            expect((await request(app).get(`/room/${id}`)).body).toMatchObject({administrator: 'alice', administrator_name: 'P alice'});

            const started = await agents.alice.post(`/room/${id}/start`);
            expect(started.status).toBe(200);
            expect(started.body.hand).toHaveLength(7);
            expect((await agents.alice.post(`/room/${id}/start`)).body.error).toBe('GAME_ALREADY_STARTED');
            expect((await join('carol', id, 'TEAM_2'))).toBe('GAME_ALREADY_STARTED');
            expect((await request(app).get(`/room/${id}`)).body.game_started).toBe(true);

            const first = await legal_play(id);
            const other = first.handle === 'alice' ? 'bob' : 'alice';
            expect((await agents[other].post(`/room/${id}/game/play`).send(first.body)).body.error).toBe('NOT_YOUR_TURN');
            const played = await agents[first.handle].post(`/room/${id}/game/play`).send(first.body);
            expect(played.status).toBe(200);
            expect(played.body.turn).toBe(2);
            expect(played.body.current_player).toBe(other);
            expect(played.body.log[0]).toMatchObject({kind: 'place', pos: {row: first.body.row, column: first.body.column}});

            const {rows: turns} = await database.pool.query(
                `SELECT turns.move_number, turns.turn, users.handle, turns.kind, turns.card,
                        turns.cell_row, turns.cell_column, turns.events
                 FROM turns JOIN games ON games.id = turns.game_id JOIN users ON users.id = turns.user_id
                 WHERE games.room_id = $1`,
                [id]
            );
            expect(turns).toEqual([{
                move_number: 1, turn: 1, handle: first.handle, kind: 'play', card: expect.any(String),
                cell_row: first.body.row, cell_column: first.body.column, events: played.body.log,
            }]);
            expect(turns[0].events[0].card).toBe(turns[0].card);
        });

        test('the first turn of round 1 goes to a seat drawn at random', async function () {
            async function opener(random) {
                const id = await open_room('carol', 2, 1);
                await join('carol', id, 'TEAM_1');
                await join('dave', id, 'TEAM_2');
                const spy = jest.spyOn(Math, 'random').mockReturnValue(random);
                try {
                    const started = await agents.carol.post(`/room/${id}/start`).expect(200);
                    const state = await require('../database/games').get({room_id: id});
                    expect([state.first, state.current, state.turn]).toEqual([state.current, state.current, 1]);
                    return started.body.current_player;
                } finally {
                    spy.mockRestore();
                }
            }
            // Seats are carol (Team 1) then dave (Team 2): a low draw picks carol, a high one dave.
            expect(await opener(0.1)).toBe('carol');
            expect(await opener(0.9)).toBe('dave');
        });

        test('lets only one of two simultaneous moves through', async function () {
            const id = await open_room('carol', 2, 1);
            await join('carol', id, 'TEAM_1');
            await join('dave', id, 'TEAM_2');
            await agents.carol.post(`/room/${id}/start`).expect(200);

            const move = await legal_play(id);
            const results = await Promise.all([1, 2].map(function () {
                return agents[move.handle].post(`/room/${id}/game/play`).send(move.body);
            }));
            expect(results.map(function (r) {
                return r.status;
            }).sort()).toEqual([200, 409]);
            const {rows} = await database.pool.query(
                'SELECT count(*) FROM turns JOIN games ON games.id = turns.game_id WHERE games.room_id = $1', [id]);
            expect(rows[0].count).toBe('1');
        });

        test('rooms and games survive a server restart, with their name and rules', async function () {
            const id = (await agents.bob.post('/room/create').send({
                number_of_team: 2, number_of_player_in_each_team: 1, name: 'Resume me', highlights: false, auto_draw_dead: true, dead_cards: 'indicator', exchanges_per_turn: 2,
            }).expect(200)).body.id;
            await join('bob', id, 'TEAM_1');
            await join('dave', id, 'TEAM_2');
            await agents.bob.post(`/room/${id}/start`).expect(200);
            const move = await legal_play(id);
            await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200);
            const before = (await agents.bob.get(`/room/${id}/game`)).body;

            // A fresh copy of every module: nothing can come from process memory.
            jest.resetModules();
            const restarted = require('../app');
            const cookie = (await request(restarted).post('/api/auth/sign-in/username')
                .send({username: 'bob', password: 'long enough'})).headers['set-cookie'][0].split(';')[0];
            const room = (await request(restarted).get(`/room/${id}`)).body;
            expect(room.teams[1].players[0].handle).toBe('dave');
            expect(room).toMatchObject({name: 'Resume me', game_started: true, settings: {highlights: false, auto_draw_dead: true}});
            const after = (await request(restarted).get(`/room/${id}/game`).set('Cookie', cookie)).body;
            // Everything but the clock reading is the same, including when the turn started.
            expect(Object.assign({}, after, {server_time: null})).toEqual(Object.assign({}, before, {server_time: null}));
            expect(after.turn_started_at).toEqual(expect.any(String));
            const {rows: [stored]} = await database.pool.query('SELECT state FROM games WHERE room_id = $1', [id]);
            expect(stored.state.rules).toEqual({auto_draw_dead: true, exchanges_per_turn: 2});
            // Signing in above ended bob's other session (one device at a time): sign his agent back in.
            await agents.bob.post('/api/auth/sign-in/username').set('Origin', ORIGIN).send({username: 'bob', password: 'long enough'}).expect(200);
        });
    });

    test('with dead cards found by hand, a player may ask for an exchange, and only a dead card is exchanged', async function () {
        const id = await open_room('alice', 2, 1, {exchanges_per_turn: 3});
        expect((await request(app).get(`/room/${id}`)).body.settings).toMatchObject({dead_cards: 'manual', exchanges_per_turn: 3});
        await join('alice', id, 'TEAM_1');
        await join('bob', id, 'TEAM_2');
        await agents.alice.post(`/room/${id}/start`).expect(200);
        const state = await require('../database/games').get({room_id: id});
        const handle = state.players[state.current].handle;
        const view = (await agents[handle].get(`/room/${id}/game`)).body;
        expect(view).toMatchObject({can_exchange: true, exchanges_left: 3});

        // A fresh deal has no dead card, so the server says the card isn't dead and nothing changes.
        const refused = await agents[handle].post(`/room/${id}/game/exchange`).send({hand_index: 0});
        expect([refused.status, refused.body.error]).toEqual([400, 'NOT_DEAD']);
        expect((await agents[handle].get(`/room/${id}/game`)).body.hand).toEqual(view.hand);

        const marked = await open_room('alice', 2, 1, {dead_cards: 'indicator', exchanges_per_turn: 'unlimited'});
        expect((await request(app).get(`/room/${marked}`)).body.settings).toMatchObject({dead_cards: 'indicator', exchanges_per_turn: null});
        const bad = await agents.alice.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1, exchanges_per_turn: 0});
        expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_SETTINGS']);
    });

    test('a pass and an exchange are recorded without a cell', async function () {
        const id = await open_room('alice', 2, 1);
        await join('alice', id, 'TEAM_1');
        await join('bob', id, 'TEAM_2');
        await agents.alice.post(`/room/${id}/start`).expect(200);
        const db_game = require('../database/games');
        const {transaction} = require('../database/pool');
        const state = await db_game.get({room_id: id});
        const handle = state.players[state.current].handle;

        await transaction(async function (client) {
            const exchanged = Object.assign({}, state, {log: state.log.concat({kind: 'exchange', card: state.hands[state.current][0]})});
            await db_game.record_move({room_id: id, previous: state, next: exchanged, handle, move: {type: 'exchange', hand_index: 0}, client});
            const passed = Object.assign({}, exchanged, {log: exchanged.log.concat({kind: 'pass'})});
            await db_game.record_move({room_id: id, previous: exchanged, next: passed, handle, move: {type: 'pass'}, client});
        });
        const {rows: [unfinished]} = await database.pool.query('SELECT winner_team, finished_at FROM games WHERE room_id = $1', [id]);
        expect(unfinished).toEqual({winner_team: null, finished_at: null});

        await transaction(async function (client) {
            const previous = await db_game.get({room_id: id, client, lock: true});
            const won = Object.assign({}, previous, {winner: 1, log: previous.log.concat({kind: 'win', team: 1})});
            await db_game.record_move({room_id: id, previous, next: won, handle, move: {type: 'pass'}, client});
        });
        const {rows: [finished]} = await database.pool.query('SELECT winner_team, finished_at FROM games WHERE room_id = $1', [id]);
        expect(finished.winner_team).toBe(1);
        expect(finished.finished_at).toBeInstanceOf(Date);
        const {rows} = await database.pool.query(
            `SELECT move_number, kind, card, cell_row, events FROM turns JOIN games ON games.id = turns.game_id
             WHERE games.room_id = $1 AND move_number <= 2 ORDER BY move_number`, [id]);
        expect(rows).toEqual([
            {move_number: 1, kind: 'exchange', card: state.hands[state.current][0], cell_row: null, events: [{kind: 'exchange', card: state.hands[state.current][0]}]},
            {move_number: 2, kind: 'pass', card: null, cell_row: null, events: [{kind: 'pass'}]},
        ]);
    });

    test('the game view says when the current turn started, and an exchange keeps it', async function () {
        const id = await open_room('alice', 2, 1);
        await join('alice', id, 'TEAM_1');
        await join('bob', id, 'TEAM_2');
        const started = (await agents.alice.post(`/room/${id}/start`).expect(200)).body;
        expect(Date.parse(started.turn_started_at)).toBeLessThanOrEqual(Date.parse(started.server_time));
        expect(Date.now() - Date.parse(started.server_time)).toBeLessThan(5000);

        await new Promise(function (resolve) {
            setTimeout(resolve, 20);
        });
        const move = await legal_play(id);
        const played = (await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200)).body;
        expect(Date.parse(played.turn_started_at)).toBeGreaterThan(Date.parse(started.turn_started_at));

        // A stored exchange: same player, same turn, so the clock keeps running.
        const db_game = require('../database/games');
        const state = await db_game.get({room_id: id});
        expect(state.turn_started_at).toBe(played.turn_started_at);
    });

    test('the turn deadline is the turn start plus the room\'s timer, stored and in the view', async function () {
        const id = await open_room('alice', 2, 1, {turn_seconds: 45});
        await join('alice', id, 'TEAM_1');
        await join('bob', id, 'TEAM_2');
        at_table(id, 'alice', 'bob');
        const started = (await agents.alice.post(`/room/${id}/start`).expect(200)).body;
        expect(Date.parse(started.turn_deadline) - Date.parse(started.turn_started_at)).toBe(45000);
        const stored = await require('../database/games').get_deadline({room_id: id});
        expect(stored.toISOString()).toBe(started.turn_deadline);

        const move = await legal_play(id);
        const played = (await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200)).body;
        expect(Date.parse(played.turn_deadline) - Date.parse(played.turn_started_at)).toBe(45000);
        expect((await require('../database/games').get_deadline({room_id: id})).toISOString()).toBe(played.turn_deadline);
    });

    describe('turn timer', function () {
        function room_game() {
            return room_game_module;
        }

        async function started_game({present = ['alice', 'bob']} = {}) {
            const id = await open_room('alice', 2, 1, {turn_seconds: 30});
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            at_table(id, ...present);
            await agents.alice.post(`/room/${id}/start`).expect(200);
            return id;
        }

        function overdue(id) {
            return database.pool.query("UPDATE games SET turn_deadline = now() - interval '1 second' WHERE room_id = $1", [id]);
        }

        test('plays a random card for a player who runs out of time', async function () {
            const id = await started_game();
            const before = await require('../database/games').get({room_id: id});
            const late = before.players[before.current];

            // Not overdue yet: nothing happens.
            expect(await room_game().expire_turn(id)).toBe(false);
            await overdue(id);
            expect(await room_game().expire_overdue_turns()).toBeGreaterThanOrEqual(1);

            const after = await require('../database/games').get({room_id: id});
            expect(after.turn).toBe(before.turn + 1);
            expect(after.current).not.toBe(before.current);
            expect(after.hands[before.current]).toHaveLength(before.hands[before.current].length);
            const placed = after.log.find(function (entry) {
                return entry.kind === 'place' || entry.kind === 'remove';
            });
            expect(placed).toMatchObject({player: late.name, timed_out: true});
            expect(before.hands[before.current]).toContain(placed.card);

            const {rows} = await database.pool.query(
                'SELECT kind, timed_out FROM turns JOIN games ON games.id = turns.game_id WHERE games.room_id = $1', [id]);
            expect(rows).toEqual([{kind: 'play', timed_out: true}]);
            // The next player has a fresh deadline, so a second sweep does nothing.
            expect(await room_game().expire_turn(id)).toBe(false);
            const view = (await agents.alice.get(`/room/${id}/game`)).body;
            expect(Date.parse(view.turn_deadline)).toBeGreaterThan(Date.now() + 25000);
        });

        test('never plays for a player who is away from the table: their turn pauses instead', async function () {
            const id = await started_game({present: []});
            await database.pool.query("UPDATE games SET state = state - 'turn_paused_at' WHERE room_id = $1", [id]);
            await database.pool.query("UPDATE games SET turn_deadline = now() - interval '1 second' WHERE room_id = $1", [id]);

            expect(await room_game().expire_turn(id)).toBe(false);
            const {rows} = await database.pool.query(
                'SELECT count(*) FROM turns JOIN games ON games.id = turns.game_id WHERE games.room_id = $1', [id]);
            expect(rows[0].count).toBe('0');
            expect(await require('../database/games').get_deadline({room_id: id})).toBe(null);
            const view = (await agents.alice.get(`/room/${id}/game`)).body;
            expect(view).toMatchObject({turn_paused: true, turn_deadline: null, turn_time_left_ms: expect.any(Number)});
        });

        test('leaves finished games and games without a deadline alone', async function () {
            const id = await started_game();
            await database.pool.query("UPDATE games SET turn_deadline = NULL WHERE room_id = $1", [id]);
            expect(await room_game().expire_turn(id)).toBe(false);
            await overdue(id);
            await database.pool.query("UPDATE games SET winner_team = 0, finished_at = now() WHERE room_id = $1", [id]);
            expect(await require('../database/games').overdue()).not.toContain(id);
        });
    });

    describe('rounds', function () {
        // Sets the current round up so the player whose turn it is wins with their next move: their team already has
        // a sequence (row 8) and four chips in row 1, and their first card is 4-Spade, which goes on (1, 5) and
        // completes the second sequence. Returns {handle, team, body}: who plays the winning move, and the move.
        async function winning_move(id) {
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
            return {handle: player.handle, team: player.team, body: {hand_index: 0, row: 1, column: 5}};
        }

        async function win_round(id) {
            const move = await winning_move(id);
            const response = await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200);
            return Object.assign({response: response.body}, move);
        }

        async function started_table(name) {
            const id = (await agents.alice.post('/room/create')
                .send({number_of_team: 2, number_of_player_in_each_team: 1, name}).expect(200)).body.id;
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            await agents.alice.post(`/room/${id}/start`).expect(200);
            return id;
        }

        test('the host deals another round with the same teams once one is won, and each round is summed up', async function () {
            const id = await started_table('Two rounds');
            const fresh = (await agents.bob.get(`/room/${id}/game`)).body;
            expect(fresh).toMatchObject({host: 'alice', rounds: {round: 1, over: false, results: [], summary: null}});
            const early = await agents.alice.post(`/room/${id}/rounds/next`);
            expect([early.status, early.body.error]).toEqual([409, 'ROUND_IN_PROGRESS']);

            const won = await win_round(id);
            expect(won.response.winner).toBe(won.team);
            expect(won.response.rounds.results).toEqual([{
                round: 1, winner: won.team, started_at: expect.any(String), finished_at: expect.any(String),
                stats: expect.objectContaining({winner: won.team, turns: 1, players: expect.any(Array), teams: expect.any(Array)}),
            }]);
            const winner_stats = won.response.rounds.results[0].stats;
            expect(winner_stats.teams[won.team]).toMatchObject({sequences: 1, placed: 1});
            expect(winner_stats.players.find(function (p) {
                return p.handle === won.handle;
            })).toMatchObject({plays: 1});
            const {rows: saved} = await database.pool.query('SELECT stats FROM games WHERE room_id = $1 AND round = 1', [id]);
            expect(saved[0].stats).toEqual(winner_stats);

            const guest = await agents.bob.post(`/room/${id}/rounds/next`);
            expect([guest.status, guest.body.error]).toEqual([403, 'NOT_HOST']);
            const next = await agents.alice.post(`/room/${id}/rounds/next`);
            expect(next.status).toBe(200);
            expect(next.body).toMatchObject({winner: null, turn: 1, rounds: {round: 2, over: false, summary: null}});
            expect(next.body.rounds.results).toHaveLength(1);
            expect(next.body.players.map(function (p) {
                return [p.handle, p.team];
            })).toEqual(won.response.players.map(function (p) {
                return [p.handle, p.team];
            }));
            expect(next.body.board.flat().every(function (cell) {
                return cell.team === null;
            })).toBe(true);
            expect((await request(app).get(`/room/${id}`)).body).toMatchObject({game_started: true, round: 2, rounds_over: false});

            // Moves go to the new round; the won one keeps its own.
            const move = await legal_play(id);
            await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200);
            const {rows} = await database.pool.query(
                `SELECT games.round, count(turns.*)::INT AS moves FROM games LEFT JOIN turns ON turns.game_id = games.id
                 WHERE games.room_id = $1 GROUP BY games.round ORDER BY games.round`, [id]);
            expect(rows).toEqual([{round: 1, moves: 1}, {round: 2, moves: 1}]);
            const listed = (await agents.bob.get('/user/rooms')).body.rooms.find(function (r) {
                return r.id === id;
            });
            expect(listed).toMatchObject({status: 'playing', round: 2, rounds_over: false, move_count: 1});
        });

        test('ending the rounds gives the final summary with the verdict, and no round can follow', async function () {
            const id = await started_table('Series');
            const first = await win_round(id);
            await agents.alice.post(`/room/${id}/rounds/next`).expect(200);
            const second = await win_round(id);

            const guest = await agents.bob.post(`/room/${id}/rounds/end`);
            expect([guest.status, guest.body.error]).toEqual([403, 'NOT_HOST']);
            const ended = await agents.alice.post(`/room/${id}/rounds/end`);
            expect(ended.status).toBe(200);
            const {summary} = ended.body.rounds;
            expect(ended.body.rounds).toMatchObject({round: 2, over: true});
            expect(summary).toMatchObject({rounds_played: 2, turns: 2});
            const wins = [0, 0];
            wins[first.team]++;
            wins[second.team]++;
            expect(summary.teams.map(function (t) {
                return t.rounds_won;
            })).toEqual(wins);
            expect(summary.verdict).toEqual(first.team === second.team
                ? {winner: first.team, leaders: [first.team]}
                : {winner: null, leaders: [0, 1]});

            expect((await agents.bob.get(`/room/${id}/game`)).body.rounds.summary).toEqual(summary);
            expect((await agents.alice.post(`/room/${id}/rounds/next`)).body.error).toBe('ROUNDS_OVER');
            expect((await agents.alice.post(`/room/${id}/rounds/end`)).body.error).toBe('ROUNDS_OVER');
            expect((await request(app).get(`/room/${id}`)).body).toMatchObject({round: 2, rounds_over: true});
        });

        test('each round starts with the next seat, so the first turn alternates between the teams', async function () {
            const id = (await agents.alice.post('/room/create')
                .send({number_of_team: 2, number_of_player_in_each_team: 2, name: 'Rotation'}).expect(200)).body.id;
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            await join('carol', id, 'TEAM_1');
            await join('dave', id, 'TEAM_2');
            await agents.alice.post(`/room/${id}/start`).expect(200);

            const starts = [];
            for (let round = 1; round <= 5; round++) {
                const state = await require('../database/games').get({room_id: id});
                expect([state.round, state.turn, state.current]).toEqual([round, 1, state.first]);
                starts.push(state.current);
                const won = await win_round(id);
                expect(won.response.rounds.results.at(-1).stats.first_player).toBe(state.players[state.first].handle);
                if (round < 5) await agents.alice.post(`/room/${id}/rounds/next`).expect(200);
            }
            // Seats alternate teams (alice, bob, carol, dave), so each round's first player is on the other team.
            expect(starts).toEqual([0, 1, 2, 3, 4].map(function (k) {
                return (starts[0] + k) % 4;
            }));
            const teams = starts.map(function (seat) {
                return seat % 2;
            });
            teams.slice(1).forEach(function (team, i) {
                expect(team).not.toBe(teams[i]);
            });
        });

        test('a round won before statistics were kept is summed up from its state', async function () {
            const id = await started_table('Legacy');
            const won = await win_round(id);
            await database.pool.query('UPDATE games SET stats = NULL WHERE room_id = $1', [id]);
            const view = (await agents.alice.get(`/room/${id}/game`)).body;
            expect(view.rounds.results[0].stats).toEqual(won.response.rounds.results[0].stats);

            await agents.alice.post(`/room/${id}/rounds/next`).expect(200);
            const {rows} = await database.pool.query('SELECT stats FROM games WHERE room_id = $1 AND round = 1', [id]);
            expect(rows[0].stats).toEqual(won.response.rounds.results[0].stats);
            // The new round's view lists it too (and gives the broadcast after the deal time to finish).
            expect((await agents.bob.get(`/room/${id}/game`)).body.rounds.results[0].stats).toEqual(rows[0].stats);
        });
    });

    describe('players away from the table', function () {
        async function started_game(present) {
            const id = await open_room('alice', 2, 1, {turn_seconds: 60});
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            at_table(id, ...present);
            await agents.alice.post(`/room/${id}/start`).expect(200);
            const state = await require('../database/games').get({room_id: id});
            return {id, current: state.players[state.current].handle, other: state.players[1 - state.current].handle};
        }

        test('the turn of a player who is away is paused, and everyone sees who is away', async function () {
            const {id, current} = await started_game([]);
            const view = (await agents.carol.get(`/room/${id}/game`)).body;
            expect(view).toMatchObject({turn_paused: true, turn_deadline: null, turn_time_left_ms: 60000, presence_token: null});
            expect(view.away.sort()).toEqual(['alice', 'bob']);
            expect(await require('../database/games').get_deadline({room_id: id})).toBe(null);
            expect(await require('../database/games').overdue({now: new Date(Date.now() + 3600 * 1000)})).not.toContain(id);

            // The player comes back: the timer starts where it stopped.
            at_table(id, current);
            expect(await room_game_module.presence_changed(id)).toBe(true);
            const back = (await agents[current].get(`/room/${id}/game`)).body;
            expect(back.turn_paused).toBe(false);
            expect(back.away).not.toContain(current);
            expect(back.presence_token).toBe(presence.token_for(id, current));
            expect(Date.parse(back.turn_deadline) - Date.now()).toBeGreaterThan(55000);
        });

        test('time spent away is not counted: a player who comes back has the time they left with', async function () {
            const {id, current} = await started_game(['alice', 'bob']);
            const games = require('../database/games');
            const started = await games.get({room_id: id});
            const t0 = Date.parse(started.turn_started_at);

            // Away 40 s into the turn, back 100 s later: 20 s left, as when they left.
            presence.depart({room_id: id, handle: current, connection: `test-${current}`});
            await room_game_module.presence_changed(id, new Date(t0 + 40000));
            expect((await agents.carol.get(`/room/${id}/game`)).body.turn_time_left_ms).toBe(20000);
            at_table(id, current);
            await room_game_module.presence_changed(id, new Date(t0 + 140000));
            expect((await games.get_deadline({room_id: id})).getTime()).toBe(t0 + 160000);

            // Away again 10 s before time is up: they come back to the same 10 s, with no minimum.
            presence.depart({room_id: id, handle: current, connection: `test-${current}`});
            await room_game_module.presence_changed(id, new Date(t0 + 150000));
            at_table(id, current);
            await room_game_module.presence_changed(id, new Date(t0 + 200000));
            expect((await games.get_deadline({room_id: id})).getTime()).toBe(t0 + 210000);
        });

        test('the next turn starts paused when its player is away', async function () {
            const {id, current, other} = await started_game([]);
            at_table(id, current);
            await room_game_module.presence_changed(id);
            const move = await legal_play(id);
            const played = (await agents[current].post(`/room/${id}/game/play`).send(move.body).expect(200)).body;
            expect(played.current_player).toBe(other);
            expect(played).toMatchObject({turn_paused: true, turn_deadline: null, turn_time_left_ms: 60000});
        });

        test('the player whose turn it is can play even if their game page has no socket open', async function () {
            const {id, current} = await started_game([]);
            const move = await legal_play(id);
            expect(move.handle).toBe(current);
            await agents[current].post(`/room/${id}/game/play`).send(move.body).expect(200);
        });
    });

    describe('game modes', function () {
        async function started(mode) {
            const id = (await agents.alice.post('/room/create')
                .send({number_of_team: 2, number_of_player_in_each_team: 1, mode}).expect(200)).body.id;
            await join('alice', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            await agents.alice.post(`/room/${id}/start`).expect(200);
            return id;
        }

        test('a training game hints the player whose turn it is, and nobody else', async function () {
            const id = await started('training');
            const state = await require('../database/games').get({room_id: id});
            const current = state.players[state.current].handle;
            const waiting = current === 'alice' ? 'bob' : 'alice';

            const mine = (await agents[current].get(`/room/${id}/game`)).body;
            expect(mine.settings.mode).toBe('training');
            expect(mine.hint).toEqual(require('../entity/hints').suggest_move(state));
            expect(mine.hint.type).toMatch(/^(play|exchange|pass)$/);
            expect((await agents[waiting].get(`/room/${id}/game`)).body.hint).toBeNull();
            expect((await request(app).get(`/room/${id}/game`)).body.hint).toBeNull();

            // The hinted move is legal.
            if (mine.hint.type === 'play') {
                const body = {hand_index: mine.hint.hand_index, row: mine.hint.target.row, column: mine.hint.target.column};
                const played = await agents[current].post(`/room/${id}/game/play`).send(body);
                expect(played.status).toBe(200);
                expect(played.body.hint).toBeNull();
            }
        });

        test('a standard game never sends a hint', async function () {
            const id = await started('standard');
            for (const handle of ['alice', 'bob']) {
                expect((await agents[handle].get(`/room/${id}/game`)).body.hint).toBeNull();
            }
        });
    });

    describe('history', function () {
        test('GET /room/:id/turns lists the moves with their players, without hands', async function () {
            const id = await open_room('carol', 2, 1, {history: true});
            await join('carol', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            expect((await request(app).get(`/room/${id}/turns`)).body.error).toBe('GAME_NOT_FOUND');
            await agents.carol.post(`/room/${id}/start`).expect(200);
            expect((await request(app).get(`/room/${id}/turns`)).body).toEqual([]);

            const first = await legal_play(id);
            await agents[first.handle].post(`/room/${id}/game/play`).send(first.body).expect(200);
            const second = await legal_play(id);
            await agents[second.handle].post(`/room/${id}/game/play`).send(second.body).expect(200);

            const turns = (await request(app).get(`/room/${id}/turns`)).body;
            expect(turns.map(function (t) {
                return [t.move_number, t.turn, t.player.handle, t.kind, t.cell];
            })).toEqual([
                [1, 1, first.handle, 'play', {row: first.body.row, column: first.body.column}],
                [2, 2, second.handle, 'play', {row: second.body.row, column: second.body.column}],
            ]);
            expect(turns[0].player.name).toBe(`P ${first.handle}`);
            expect(JSON.stringify(turns)).not.toMatch(/"(hands?|deck|discard)"/);
            expect((await request(app).get('/room/nope/turns')).status).toBe(404);
        });

        test('a table without history hides its turns and keeps only the latest move in the game view', async function () {
            const response = await agents.carol.post('/room/create')
                .send({number_of_team: 2, number_of_player_in_each_team: 1, name: 'Quiet', history: false}).expect(200);
            const id = response.body.id;
            await join('carol', id, 'TEAM_1');
            await join('bob', id, 'TEAM_2');
            const started = await agents.carol.post(`/room/${id}/start`).expect(200);
            expect(started.body.name).toBe('Quiet');
            expect(started.body.settings).toEqual({
                mode: 'standard', history: false, highlights: false, auto_draw_dead: false, turn_seconds: 90,
                dead_cards: 'manual', exchanges_per_turn: null,
            });

            for (let i = 0; i < 3; i++) {
                const move = await legal_play(id);
                await agents[move.handle].post(`/room/${id}/game/play`).send(move.body).expect(200);
            }
            const game = (await agents.carol.get(`/room/${id}/game`)).body;
            expect(game.log.every(function (entry) {
                return entry.turn >= game.turn - 1;
            })).toBe(true);
            const turns = await request(app).get(`/room/${id}/turns`);
            expect([turns.status, turns.body.error]).toEqual([403, 'HISTORY_DISABLED']);
            // Still recorded, so "Your tables" can count the moves.
            const rooms = (await agents.carol.get('/user/rooms')).body.rooms;
            expect(rooms.find(function (r) {
                return r.id === id;
            })).toMatchObject({name: 'Quiet', move_count: 3, settings: {history: false}});
        });

        test('GET /user/rooms lists the tables a user created or sat at, newest first', async function () {
            await sign_up('erin');
            await sign_up('frank');
            const created_only = await open_room('erin', 2, 1);
            const played = await open_room('frank', 2, 1);
            await join('frank', played, 'TEAM_1');
            await join('erin', played, 'TEAM_2');
            await agents.frank.post(`/room/${played}/start`).expect(200);
            const move = await legal_play(played);
            await agents[move.handle].post(`/room/${played}/game/play`).send(move.body).expect(200);
            await open_room('frank', 2, 1); // not Erin's

            const {rooms, total, page, pages} = (await agents.erin.get('/user/rooms')).body;
            expect({total, page, pages}).toEqual({total: 2, page: 1, pages: 1});
            expect(rooms.map(function (r) {
                return [r.id, r.administrator, r.your_team, r.seats_taken, r.status, r.move_count];
            })).toEqual([
                [played, 'frank', 1, 2, 'playing', 1],
                [created_only, 'erin', null, 0, 'open', 0],
            ]);
            expect(rooms[0].started_at).toEqual(expect.any(String));
            expect(rooms[0].finished_at).toBeNull();

            const response = await request(app).get('/user/rooms');
            expect(response.status).toBe(401);
        });

        test('GET /user/current-game is the seated game in progress that moved last', async function () {
            await sign_up('hana');
            await sign_up('ivan');
            expect((await agents.hana.get('/user/current-game')).body).toEqual({room: null});

            async function playing(name) {
                const id = (await agents.hana.post('/room/create')
                    .send({number_of_team: 2, number_of_player_in_each_team: 1, name}).expect(200)).body.id;
                await join('hana', id, 'TEAM_1');
                await join('ivan', id, 'TEAM_2');
                await agents.hana.post(`/room/${id}/start`).expect(200);
                return id;
            }
            const older = await playing('Older');
            const newer = await playing('Newer');
            await open_room('hana'); // open, no game: never current
            expect((await agents.hana.get('/user/current-game')).body.room).toMatchObject({id: newer, status: 'playing', your_team: 0});

            // A move at the older table makes it the latest.
            const move = await legal_play(older);
            await agents[move.handle].post(`/room/${older}/game/play`).send(move.body).expect(200);
            const current = (await agents.hana.get('/user/current-game')).body.room;
            expect(current).toMatchObject({id: older, name: 'Older', move_count: 1});
            expect(current.last_move_at).toEqual(expect.any(String));

            expect((await request(app).get('/user/current-game')).status).toBe(401);
        });

        test('GET /user/rooms pages through the tables without repeats', async function () {
            await sign_up('gina');
            const opened = [];
            for (let i = 0; i < 5; i++) opened.unshift(await open_room('gina'));

            const first = (await agents.gina.get('/user/rooms?page=1&per_page=2')).body;
            expect({page: first.page, per_page: first.per_page, total: first.total, pages: first.pages})
                .toEqual({page: 1, per_page: 2, total: 5, pages: 3});
            const pages = [first];
            for (const page of [2, 3]) pages.push((await agents.gina.get(`/user/rooms?page=${page}&per_page=2`)).body);
            expect(pages.flatMap(function (p) {
                return p.rooms.map(function (r) {
                    return r.id;
                });
            })).toEqual(opened);

            expect((await agents.gina.get('/user/rooms?page=9&per_page=2')).body.rooms).toEqual([]);
            // Bad or missing numbers fall back to the first page of 10; per_page is capped at 50.
            const fallback = (await agents.gina.get('/user/rooms?page=zero&per_page=-3')).body;
            expect([fallback.page, fallback.per_page, fallback.rooms.length]).toEqual([1, 10, 5]);
            expect((await agents.gina.get('/user/rooms?per_page=500')).body.per_page).toBe(50);
        });
    });
});
