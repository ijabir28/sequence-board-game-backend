// Tests for deleting tables whose game never started once nobody has touched them for a while. Need PostgreSQL, see
// database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

describe_with_database('idle open table cleanup', function () {
    const DAY_MS = 24 * 60 * 60 * 1000;
    let database;
    let app;
    let room;
    const agents = {};

    async function sign_up(handle) {
        agents[handle] = await verified_account(request, app, {username: handle, name: `P ${handle}`, email: `${handle}@example.test`});
    }

    async function open_room(players = 1) {
        const response = await agents.host.post('/room/create').send({number_of_team: 2, number_of_player_in_each_team: players}).expect(200);
        return response.body.id;
    }

    function join(handle, id, team_handle) {
        return agents[handle].post(`/room/${id}/join`).send({team_handle}).expect(200);
    }

    // Moves everything that happened at the table `days` into the past.
    async function age(id, days) {
        const shift = `${days} days`;
        await database.pool.query('UPDATE rooms SET created_at = created_at - $2::INTERVAL WHERE id = $1', [id, shift]);
        await database.pool.query('UPDATE room_seats SET joined_at = joined_at - $2::INTERVAL WHERE room_id = $1', [id, shift]);
        await database.pool.query('UPDATE room_members SET joined_at = joined_at - $2::INTERVAL WHERE room_id = $1', [id, shift]);
        await database.pool.query('UPDATE table_invitations SET created_at = created_at - $2::INTERVAL WHERE room_id = $1', [id, shift]);
    }

    async function exists(id) {
        return (await agents.host.get(`/room/${id}`).expect(200)).text !== '';
    }

    beforeAll(async function () {
        database = await use_test_schema('open_table_cleanup');
        app = require('../app');
        room = require('./room');
        for (const handle of ['host', 'ann', 'ben']) await sign_up(handle);
        await agents.host.post('/friends/requests').send({handle: 'ben'}).expect(200);
        await agents.ben.post('/friends/requests/host/accept').expect(200);
    });

    afterAll(async function () {
        await database.drop();
    });

    test('deletes a table whose game never started once nothing has happened there for a day', async function () {
        const idle = await open_room(2);
        await join('ann', idle, 'TEAM_1');
        await agents.host.post(`/room/${idle}/invite`).send({handle: 'ben'}).expect(200);
        await age(idle, 2);
        const fresh = await open_room();

        expect(await room.delete_idle_open_tables()).toEqual([idle]);
        expect(await exists(idle)).toBe(false);
        expect(await exists(fresh)).toBe(true);
        const {rows} = await database.pool.query(
            `SELECT (SELECT count(*) FROM room_seats WHERE room_id = $1) + (SELECT count(*) FROM room_members WHERE room_id = $1)
                    + (SELECT count(*) FROM table_invitations WHERE room_id = $1) AS left_over`,
            [idle]
        );
        expect(Number(rows[0].left_over)).toBe(0);
        expect((await agents.ben.get('/friends/invitations')).body.invitations).toEqual([]);
    });

    test('keeps an old table where someone sat down lately', async function () {
        const id = await open_room();
        await age(id, 3);
        await join('ann', id, 'TEAM_1');
        expect(await room.delete_idle_open_tables()).not.toContain(id);
        // A day later it is idle too.
        expect(await room.delete_idle_open_tables({now: Date.now() + DAY_MS + 60000})).toContain(id);
    });

    test('never deletes a table whose game has started', async function () {
        const id = await open_room();
        await join('ann', id, 'TEAM_1');
        await join('host', id, 'TEAM_2');
        await agents.host.post(`/room/${id}/start`).expect(200);
        await age(id, 30);
        expect(await room.delete_idle_open_tables()).not.toContain(id);
        expect(await exists(id)).toBe(true);
    });
});
