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

    test('a dismissed invitation can be sent again only after a wait that grows, at most five times', async function () {
        const id = await open_room();
        // As if the last dismissal was `minutes` ago.
        const age = (minutes) => database.pool.query(
            "UPDATE table_invitation_dismissals SET last_dismissed_at = now() - make_interval(mins => $2) WHERE room_id = $1", [id, minutes]);
        const invite = () => agents.host.post(`/room/${id}/invite`).send({handle: 'cat'});
        for (const [i, minutes] of [5, 15, 30, 60, 120].entries()) {
            await invite().expect(200);
            await agents.cat.delete(`/friends/invitations/${id}`).expect(204);
            const refused = await invite();
            expect([refused.status, refused.body.error]).toEqual([429, 'INVITE_COOLDOWN']);
            expect(refused.body.message).toMatch(`again in ${['5 minutes', '15 minutes', '30 minutes', '1 hour', '2 hours'][i]}`);
            const status = (await agents.host.get(`/room/${id}/invite-status`).expect(200)).body;
            expect(status.dismissed).toEqual([expect.objectContaining({handle: 'cat', dismissals: i + 1, limit_reached: false})]);
            expect(status.dismissed[0].retry_at).not.toBeNull();
            await age(minutes - 1);
            expect((await invite()).body.error).toBe('INVITE_COOLDOWN');
            await age(minutes);
        }
        // The sixth invitation (the fifth re-invite) is the last one.
        await invite().expect(200);
        await agents.cat.delete(`/friends/invitations/${id}`).expect(204);
        await age(10000);
        const refused = await invite();
        expect([refused.status, refused.body.error]).toEqual([409, 'INVITE_LIMIT']);
        expect((await agents.host.get(`/room/${id}/invite-status`)).body.dismissed[0]).toMatchObject({retry_at: null, limit_reached: true});

        // Sitting down or the host taking an invitation back isn't turning it down.
        await agents.host.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200);
        await agents.host.delete(`/room/${id}/invitations/ben`).expect(200);
        await agents.host.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200);
    });

    test('only players who may invite see who is waiting, and only the host sees who was removed', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        expect(await join('ben', id, 'TEAM_2')).toBe('success');
        await agents.host.post(`/room/${id}/kick`).send({handle: 'ben'}).expect(200);
        expect((await agents.host.get(`/room/${id}/invite-status`).expect(200)).body).toEqual({dismissed: [], removed: ['ben']});
        expect((await agents.ann.get(`/room/${id}/invite-status`).expect(200)).body).toEqual({dismissed: [], removed: []});
        expect((await agents.cat.get(`/room/${id}/invite-status`)).body.error).toBe('NOT_AT_TABLE');
        // The host invites ben back: he may sit down again.
        await agents.host.post(`/room/${id}/invite`).send({handle: 'ben'}).expect(200);
        expect((await agents.host.get(`/room/${id}/invite-status`)).body.removed).toEqual([]);
        expect(await join('ben', id, 'TEAM_2')).toBe('success');
    });

    test('a removed player who is not the host\'s friend asks to rejoin, and the host lets them back in', async function () {
        await sign_up('dan');
        const id = await open_room();
        expect(await join('dan', id, 'TEAM_1')).toBe('success');
        expect((await agents.dan.get(`/room/${id}/rejoin`).expect(200)).body).toEqual({removed: false, requested: false, declined: false});
        expect((await agents.dan.post(`/room/${id}/rejoin`)).body.error).toBe('NOT_REMOVED');

        await agents.host.post(`/room/${id}/kick`).send({handle: 'dan'}).expect(200);
        // Not friends, so the host can't invite him back.
        expect((await agents.host.post(`/room/${id}/invite`).send({handle: 'dan'})).body.error).toBe('NOT_FRIENDS');
        expect((await agents.dan.post(`/room/${id}/rejoin`).expect(200)).body).toEqual({removed: true, requested: true, declined: false});
        expect((await agents.dan.post(`/room/${id}/rejoin`)).body.error).toBe('ALREADY_ASKED');
        const list = (await agents.host.get(`/room/${id}/removed`).expect(200)).body.removed;
        expect(list).toEqual([expect.objectContaining({handle: 'dan', name: 'P dan', rejoin_declined: false})]);
        expect(list[0].rejoin_requested_at).not.toBeNull();
        expect((await agents.ann.get(`/room/${id}/removed`)).body.error).toBe('NOT_HOST');
        expect((await agents.ann.post(`/room/${id}/readmit`).send({handle: 'dan'})).body.error).toBe('NOT_HOST');

        const room = (await agents.host.post(`/room/${id}/readmit`).send({handle: 'dan'}).expect(200)).body;
        expect(room.standing.map((p) => p.handle)).toEqual(['dan']);
        expect((await agents.host.post(`/room/${id}/readmit`).send({handle: 'dan'})).body.error).toBe('NOT_REMOVED');
        expect((await agents.host.get(`/room/${id}/removed`)).body.removed).toEqual([]);
        expect(await join('dan', id, 'TEAM_2')).toBe('success');
    });

    test('a declined request to rejoin can\'t be sent again, but the host can still let them in', async function () {
        const id = await open_room();
        expect(await join('ann', id, 'TEAM_1')).toBe('success');
        await agents.host.post(`/room/${id}/kick`).send({handle: 'ann'}).expect(200);
        expect((await agents.host.delete(`/room/${id}/rejoin/ann`)).body.error).toBe('NO_REJOIN_REQUEST');
        await agents.ann.post(`/room/${id}/rejoin`).expect(200);
        await agents.host.delete(`/room/${id}/rejoin/ann`).expect(204);
        expect((await agents.ann.get(`/room/${id}/rejoin`)).body).toEqual({removed: true, requested: true, declined: true});
        expect((await agents.ann.post(`/room/${id}/rejoin`)).body.error).toBe('REJOIN_DECLINED');
        expect(await join('ann', id, 'TEAM_1')).toBe('REMOVED_BY_HOST');
        await agents.host.post(`/room/${id}/readmit`).send({handle: 'ann'}).expect(200);
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
