// HTTP tests for friends: searching, requests and their answers, unfriending, and inviting friends to a table.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('friends', function () {
    let database;
    let app;
    const agents = {};

    async function sign_up(handle, name = `P ${handle}`) {
        agents[handle] = await verified_account(request, app, {username: handle, name, email: `${handle}@example.test`});
    }

    function overview(handle) {
        return agents[handle].get('/friends/list').expect(200).then((response) => response.body);
    }

    function ask(from, to) {
        return agents[from].post('/friends/requests').send({handle: to});
    }

    beforeAll(async function () {
        database = await use_test_schema('friends');
        app = require('../app');
        for (const handle of ['ann', 'ben', 'cat', 'dan', 'eve']) await sign_up(handle);
        await sign_up('zed_one', 'Annabel');
    });

    afterAll(async function () {
        await database.drop();
    });

    test('needs a signed-in player', async function () {
        expect((await request(app).get('/friends/list')).status).toBe(401);
        expect((await request(app).post('/friends/requests').send({handle: 'ann'})).status).toBe(401);
    });

    test('search finds players by handle or name, never the player themself or a bot', async function () {
        const short = await agents.ann.get('/friends/search').query({q: 'a'});
        expect([short.status, short.body.error]).toEqual([400, 'INVALID_SEARCH']);

        const {body} = await agents.ben.get('/friends/search').query({q: 'an'}).expect(200);
        // ann by her handle; dan ("P dan") and zed_one ("Annabel") by name. Handles starting with it come first.
        expect(body.players.map((p) => p.handle)).toEqual(['ann', 'dan', 'zed_one']);
        expect(body.players[0]).toEqual({handle: 'ann', name: 'P ann', image: null, relationship: 'none'});

        // Never ann herself, though "Annabel" still matches.
        expect((await agents.ann.get('/friends/search').query({q: 'ann'})).body.players.map((p) => p.handle)).toEqual(['zed_one']);
        const {rows: [bot]} = await database.pool.query('SELECT handle FROM users WHERE is_bot LIMIT 1');
        expect((await agents.ann.get('/friends/search').query({q: bot.handle})).body.players).toEqual([]);
        // LIKE wildcards are taken literally.
        expect((await agents.ann.get('/friends/search').query({q: '%%'})).body.players).toEqual([]);
        expect((await agents.ann.get('/friends/search').query({q: '_o'})).body.players.map((p) => p.handle)).toEqual([]);
    });

    test('a request waits until it is accepted, then both are friends', async function () {
        const sent = await ask('ann', '@BEN').expect(200);
        expect(sent.body).toEqual({handle: 'ben', relationship: 'outgoing'});
        expect((await ask('ann', 'ben')).body.error).toBe('ALREADY_REQUESTED');

        expect(await overview('ann')).toMatchObject({friends: [], incoming: [], outgoing: [{handle: 'ben', name: 'P ben'}]});
        expect(await overview('ben')).toMatchObject({friends: [], incoming: [{handle: 'ann'}], outgoing: []});
        expect((await agents.ben.get('/friends/search').query({q: 'ann'})).body.players[0].relationship).toBe('incoming');

        // Only ben can accept it.
        expect((await agents.ann.post('/friends/requests/ben/accept')).status).toBe(404);
        expect((await agents.ben.post('/friends/requests/ann/accept').expect(200)).body).toEqual({handle: 'ann', relationship: 'friends'});

        const ann = await overview('ann');
        expect(ann.friends).toEqual([expect.objectContaining({handle: 'ben', name: 'P ben', online: false, playing: false, watch: null})]);
        expect([ann.incoming, ann.outgoing]).toEqual([[], []]);
        expect((await overview('ben')).friends.map((f) => f.handle)).toEqual(['ann']);
        expect((await ask('ben', 'ann')).body.error).toBe('ALREADY_FRIENDS');
    });

    test('asking someone who already asked you accepts their request', async function () {
        await ask('cat', 'dan').expect(200);
        expect((await ask('dan', 'cat').expect(200)).body.relationship).toBe('friends');
        expect((await overview('cat')).friends.map((f) => f.handle)).toEqual(['dan']);
    });

    test('requests can be declined or taken back, and friends removed', async function () {
        await ask('eve', 'ann').expect(200);
        await agents.ann.delete('/friends/requests/eve').expect(204);
        expect((await overview('eve')).outgoing).toEqual([]);

        await ask('eve', 'ann').expect(200);
        await agents.eve.delete('/friends/requests/ann').expect(204);
        expect((await overview('ann')).incoming).toEqual([]);
        expect((await agents.eve.delete('/friends/requests/ann')).status).toBe(404);

        await ask('eve', 'cat').expect(200);
        await agents.cat.post('/friends/requests/eve/accept').expect(200);
        await agents.eve.delete('/friends/cat').expect(204);
        expect((await overview('cat')).friends.map((f) => f.handle)).toEqual(['dan']);
        expect((await agents.eve.delete('/friends/cat')).body.error).toBe('NOT_FRIENDS');
    });

    test('refuses unknown players, bots and the player themself', async function () {
        expect((await ask('ann', 'nobody_here')).body.error).toBe('PLAYER_NOT_FOUND');
        expect((await ask('ann', '')).body.error).toBe('PLAYER_NOT_FOUND');
        expect((await ask('ann', 'ann')).body.error).toBe('CANNOT_FRIEND_SELF');
        const {rows: [bot]} = await database.pool.query('SELECT handle FROM users WHERE is_bot LIMIT 1');
        expect((await ask('ann', bot.handle)).status).toBe(404);
    });

    describe('table invitations', function () {
        let id;

        beforeAll(async function () {
            id = (await agents.ann.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1}).expect(200)).body.id;
        });

        test('only friends can be invited, by someone at the table', async function () {
            expect((await agents.ann.post(`/room/${id}/invite`).send({handle: 'cat'})).body.error).toBe('NOT_FRIENDS');
            expect((await agents.cat.post(`/room/${id}/invite`).send({handle: 'dan'})).body.error).toBe('NOT_AT_TABLE');
            expect((await agents.ann.post('/room/no-such-table/invite').send({handle: 'ben'})).status).toBe(404);
        });

        test('an invited friend sees the table until they sit down there', async function () {
            expect((await agents.ann.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200)).body).toEqual({handle: 'ben'});
            // Again only renews it.
            await agents.ann.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200);
            const {invitations} = await overview('ben');
            expect(invitations).toEqual([expect.objectContaining({
                room_id: id, from: {handle: 'ann', name: 'P ann', image: null}, seats_taken: 0, seats: 2,
            })]);
            expect((await agents.ben.get('/friends/invitations').expect(200)).body.invitations).toHaveLength(1);

            await agents.ben.post(`/room/${id}/join`).send({team_handle: 'TEAM_2'}).expect(200);
            expect((await overview('ben')).invitations).toEqual([]);
            expect((await agents.ann.post(`/room/${id}/invite`).send({handle: 'ben'})).body.error).toBe('ALREADY_SEATED');
        });

        test('a dismissed invitation goes; a started game takes no more', async function () {
            const other = (await agents.cat.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: 1}).expect(200)).body.id;
            await agents.cat.post(`/room/${other}/invite`).send({handle: 'dan'}).expect(200);
            await agents.dan.delete(`/friends/invitations/${other}`).expect(204);
            expect((await overview('dan')).invitations).toEqual([]);
            expect((await agents.dan.delete(`/friends/invitations/${other}`)).status).toBe(404);

            await agents.cat.post(`/room/${other}/invite`).send({handle: 'dan'}).expect(200);
            await agents.cat.post(`/room/${other}/join`).send({team_handle: 'TEAM_1'}).expect(200);
            await agents.ann.post(`/room/${id}/join`).send({team_handle: 'TEAM_1'}).expect(200);
            await agents.ann.post(`/room/${id}/start`).expect(200);
            expect((await agents.ann.post(`/room/${id}/invite`).send({handle: 'ben'})).body.error).toBe('GAME_ALREADY_STARTED');

            // ann's list says ben is playing, but not where: he hasn't let friends watch.
            expect((await overview('ann')).friends).toEqual([expect.objectContaining({handle: 'ben', playing: true, watch: null})]);
            expect((await agents.ben.get('/user/profile')).body.friends_can_watch).toBe(false);
            const bad = await agents.ben.put('/user/friends-can-watch').send({friends_can_watch: 'yes'});
            expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_SETTING']);
            // Once he does, the list links to his table; turning it off hides it again.
            expect((await agents.ben.put('/user/friends-can-watch').send({friends_can_watch: true}).expect(200)).body)
                .toEqual({friends_can_watch: true});
            expect((await agents.ben.get('/user/profile')).body.friends_can_watch).toBe(true);
            expect((await overview('ann')).friends).toEqual([expect.objectContaining({handle: 'ben', playing: true, watch: id})]);
            await agents.ben.put('/user/friends-can-watch').send({friends_can_watch: false}).expect(200);
            expect((await overview('ann')).friends).toEqual([expect.objectContaining({handle: 'ben', playing: true, watch: null})]);
            expect((await request(app).put('/user/friends-can-watch').send({friends_can_watch: true})).status).toBe(401);
            // dan still has cat's open table.
            expect((await overview('dan')).invitations.map((i) => i.room_id)).toEqual([other]);

            // Unfriending drops the invitations between them.
            await agents.dan.delete('/friends/cat').expect(204);
            expect((await overview('dan')).invitations).toEqual([]);
        });
    });
});
