// HTTP tests for the host's seating controls: seating, standing up, sending away and taking back invitations.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('host controls', function () {
    let database;
    let app;
    const agents = {};

    async function sign_up(handle) {
        agents[handle] = await verified_account(request, app, {username: handle, name: `P ${handle}`, email: `${handle}@example.test`});
    }

    async function befriend(a, b) {
        await agents[a].post('/friends/requests').send({handle: b}).expect(200);
        await agents[b].post(`/friends/requests/${a}/accept`).expect(200);
    }

    async function open_room(teams = 2, players = 2) {
        const response = await agents.host.post('/room/create').send({number_of_team: teams, number_of_player_in_each_team: players}).expect(200);
        return response.body.id;
    }

    function join(handle, id, team_handle) {
        return agents[handle].post(`/room/${id}/join`).send({team_handle}).then((response) => response.body.message);
    }

    function seats(room) {
        return room.teams.map((team) => team.players.map((player) => player && player.handle));
    }

    beforeAll(async function () {
        database = await use_test_schema('host_controls');
        app = require('../app');
        for (const handle of ['host', 'ann', 'ben', 'cat']) await sign_up(handle);
        for (const friend of ['ann', 'ben', 'cat']) await befriend('host', friend);
    });

    afterAll(async function () {
        await database.drop();
    });

    test('only the host, before the game starts', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        for (const [path, body] of [['seat', {handle: 'ann', team_handle: 'TEAM_2', seat: 0}], ['unseat', {handle: 'ann'}], ['kick', {handle: 'ann'}]]) {
            const response = await agents.ann.post(`/room/${id}/${path}`).send(body);
            expect([response.status, response.body.error]).toEqual([403, 'NOT_HOST']);
            expect((await request(app).post(`/room/${id}/${path}`).send(body)).status).toBe(401);
        }
        expect((await agents.host.post(`/room/${id}/unseat`).send({handle: 'nobody'})).body.error).toBe('PLAYER_NOT_FOUND');
    });

    test('the host stands a player up, and they stay at the table to be seated again', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        const stood = (await agents.host.post(`/room/${id}/unseat`).send({handle: 'ann'}).expect(200)).body;
        expect(seats(stood)).toEqual([[null, null], [null, null]]);
        expect(stood.standing).toEqual([{handle: 'ann', name: 'P ann'}]);
        expect((await agents.host.post(`/room/${id}/unseat`).send({handle: 'ann'})).body.error).toBe('NOT_SEATED');

        const seated = (await agents.host.post(`/room/${id}/seat`).send({handle: 'ann', team_handle: 'TEAM_2', seat: 1}).expect(200)).body;
        expect(seats(seated)).toEqual([[null, null], [null, 'ann']]);
        expect(seated.standing).toEqual([]);
    });

    test('seating someone in a taken seat trades places, or stands the occupant up', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        expect(await join('ben', id, 'TEAM_2')).toBe('success');
        const traded = (await agents.host.post(`/room/${id}/seat`).send({handle: 'ann', team_handle: 'TEAM_2', seat: 0}).expect(200)).body;
        expect(seats(traded)).toEqual([['ben', null], ['ann', null]]);

        // The host seats themself in ben's seat: they had none, so ben stands up.
        const taken = (await agents.host.post(`/room/${id}/seat`).send({handle: 'host', team_handle: 'TEAM_1', seat: 0}).expect(200)).body;
        expect(seats(taken)).toEqual([['host', null], ['ann', null]]);
        expect(taken.standing.map((p) => p.handle)).toEqual(['ben']);

        for (const seat of [{team_handle: 'TEAM_3', seat: 0}, {team_handle: 'TEAM_1', seat: 2}, {team_handle: 'TEAM_1', seat: -1}]) {
            expect((await agents.host.post(`/room/${id}/seat`).send({handle: 'ben', ...seat})).body.error).toBe('SEAT_NOT_FOUND');
        }
        // cat never came to the table.
        expect((await agents.host.post(`/room/${id}/seat`).send({handle: 'cat', team_handle: 'TEAM_1', seat: 1})).body.error).toBe('NOT_AT_TABLE');
    });

    test('the host seats an invited player, which answers their invitation', async function () {
        const id = await open_room();
        await agents.host.post(`/room/${id}/invite`).send({handle: 'cat'}).expect(200);
        expect((await agents.host.get(`/room/${id}`)).body.invited).toEqual([{handle: 'cat', name: 'P cat', invited_by: 'host'}]);
        const room = (await agents.host.post(`/room/${id}/seat`).send({handle: 'cat', team_handle: 'TEAM_1', seat: 1}).expect(200)).body;
        expect(seats(room)).toEqual([[null, 'cat'], [null, null]]);
        expect(room.invited).toEqual([]);
        const {rows} = await database.pool.query('SELECT 1 FROM table_invitations WHERE room_id = $1', [id]);
        expect(rows).toEqual([]);
    });

    test('the host takes back an invitation', async function () {
        const id = await open_room();
        await agents.host.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200);
        const room = (await agents.host.delete(`/room/${id}/invitations/ben`).expect(200)).body;
        expect(room.invited).toEqual([]);
        expect((await agents.host.delete(`/room/${id}/invitations/ben`)).body.error).toBe('NOT_INVITED');
        expect((await agents.ann.delete(`/room/${id}/invitations/ben`)).body.error).toBe('NOT_HOST');
    });

    test('a player the host sends away can sit down again only once the host invites them back', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        expect(await join('ben', id, 'TEAM_2')).toBe('success');
        const room = (await agents.host.post(`/room/${id}/kick`).send({handle: 'ann'}).expect(200)).body;
        expect(seats(room)).toEqual([[null, null], ['ben', null]]);
        expect(room.standing).toEqual([]);
        expect(await join('ann', id, 'TEAM_1')).toBe('REMOVED_BY_HOST');
        expect((await agents.host.post(`/room/${id}/kick`).send({handle: 'host'})).body.error).toBe('CANNOT_KICK_SELF');

        // ben, seated there, can't ask her back; the host can.
        await befriend('ann', 'ben');
        expect((await agents.ben.post(`/room/${id}/invite`).send({handle: 'ann'})).body.error).toBe('REMOVED_BY_HOST');
        await agents.host.post(`/room/${id}/invite`).send({handle: 'ann'}).expect(200);
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
    });

    test('seats are fixed once the game starts', async function () {
        const id = await open_room(2, 1);
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        expect(await join('ben', id, 'TEAM_2')).toBe('success');
        await agents.host.post(`/room/${id}/start`).expect(200);
        for (const path of ['unseat', 'kick']) {
            expect((await agents.host.post(`/room/${id}/${path}`).send({handle: 'ann'})).body.error).toBe('GAME_ALREADY_STARTED');
        }
    });
});
