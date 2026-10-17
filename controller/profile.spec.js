// HTTP tests for the player's profile: name, avatar, email, password and sessions.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');
const {ORIGIN, link_in, insert_legacy_user, mail_to, verified_account} = require('./test_accounts');

const describe_with_database = has_database ? describe : describe.skip;

// The smallest valid PNG: 1×1, transparent.
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex'
);

describe_with_database('profile', function () {
    let database;
    let app;
    let player;

    beforeAll(async function () {
        database = await use_test_schema('profile');
        app = require('../app');
        player = await verified_account(request, app, {username: 'player', name: 'Player', email: 'player@example.test'});
    });

    afterAll(async function () {
        await database.drop();
    });

    function update_user(agent, body) {
        return agent.post('/api/auth/update-user').set('Origin', ORIGIN).send(body);
    }

    describe('GET /user/profile', function () {
        test('has when the account was made and how its games went', async function () {
            const {body} = await player.get('/user/profile').expect(200);
            expect(body).toMatchObject({handle: 'player', email: 'player@example.test', email_verified: true, image: null});
            expect(Date.parse(body.created_at)).toBeLessThanOrEqual(Date.now());
            expect(body.stats).toEqual({played: 0, won: 0, playing: 0});
        });
    });

    describe('display name', function () {
        test('changes through Better Auth, with our rule', async function () {
            expect((await update_user(player, {name: '  Renamed  '})).status).toBe(200);
            expect((await player.get('/user/profile')).body.name).toBe('Renamed');

            const long = await update_user(player, {name: 'x'.repeat(11)});
            expect([long.status, long.body.code]).toEqual([400, 'INVALID_NAME']);
        });

        test('the handle never changes, since games refer to players by it', async function () {
            const response = await update_user(player, {username: 'someone_new'});
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('USERNAME_IS_IMMUTABLE');
        });

        test('the avatar URL cannot be set directly', async function () {
            const response = await update_user(player, {image: 'https://tracker.example/pixel.png'});
            expect([response.status, response.body.code]).toEqual([400, 'IMAGE_READ_ONLY']);
            expect((await player.get('/user/profile')).body.image).toBeNull();
        });
    });

    describe('avatar', function () {
        test('uploads, serves and removes a picture', async function () {
            const upload = await player.put('/user/avatar').set('Content-Type', 'image/png').send(PNG);
            expect(upload.status).toBe(200);
            expect(upload.body.image).toMatch(/^\/user\/avatar\/\d+\?v=\w+$/);
            expect((await player.get('/user/profile')).body.image).toBe(upload.body.image);

            // Anyone can see it, as an image that is never run as anything else.
            const served = await request(app).get(upload.body.image).buffer(true).parse(function (res, done) {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => done(null, Buffer.concat(chunks)));
            });
            expect(served.status).toBe(200);
            expect(served.headers['content-type']).toBe('image/png');
            expect(served.headers['x-content-type-options']).toBe('nosniff');
            expect(served.headers['cache-control']).toContain('immutable');
            expect(Buffer.compare(served.body, PNG)).toBe(0);

            // A new upload gets a new URL, so caches never show the old picture.
            const again = await player.put('/user/avatar').set('Content-Type', 'image/png').send(PNG);
            expect(again.body.image).not.toBe(upload.body.image);

            expect((await player.delete('/user/avatar')).status).toBe(204);
            expect((await player.get('/user/profile')).body.image).toBeNull();
            expect((await request(app).get(upload.body.image)).status).toBe(404);
        });

        test('accepts only PNG, JPEG and WebP, judged by the bytes', async function () {
            const svg = await player.put('/user/avatar').set('Content-Type', 'image/svg+xml').send('<svg onload="alert(1)"/>');
            expect([svg.status, svg.body.error]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);

            const disguised = await player.put('/user/avatar').set('Content-Type', 'image/png').send(Buffer.from('<html>'));
            expect([disguised.status, disguised.body.error]).toEqual([400, 'INVALID_IMAGE']);

            const large = Buffer.concat([PNG, Buffer.alloc(256 * 1024)]);
            const too_large = await player.put('/user/avatar').set('Content-Type', 'image/png').send(large);
            expect([too_large.status, too_large.body.error]).toEqual([413, 'IMAGE_TOO_LARGE']);
        });

        test('needs a session to change, and 404s for anyone without one', async function () {
            expect((await request(app).put('/user/avatar').set('Content-Type', 'image/png').send(PNG)).status).toBe(401);
            expect((await request(app).delete('/user/avatar')).status).toBe(401);
            expect((await request(app).get('/user/avatar/999999')).status).toBe(404);
            expect((await request(app).get('/user/avatar/not-a-number')).status).toBe(404);
        });
    });

    describe('card deck', function () {
        test('is null until chosen, then saved on the account', async function () {
            expect((await player.get('/user/profile')).body.card_deck).toBeNull();
            const saved = await player.put('/user/card-deck').send({card_deck: 'jumbo'});
            expect([saved.status, saved.body]).toEqual([200, {card_deck: 'jumbo'}]);
            expect((await player.get('/user/profile')).body.card_deck).toBe('jumbo');
        });

        test('refuses something that is not a deck id', async function () {
            const response = await player.put('/user/card-deck').send({card_deck: '<script>'});
            expect([response.status, response.body.error]).toEqual([400, 'INVALID_CARD_DECK']);
            expect((await player.get('/user/profile')).body.card_deck).toBe('jumbo');
        });

        test('needs a session', async function () {
            expect((await request(app).put('/user/card-deck').send({card_deck: 'classic'})).status).toBe(401);
        });
    });

    describe('password', function () {
        test('changes with the current one, signs out other devices and tells the owner', async function () {
            const other_device = await verified_account(request, app, {username: 'changer', email: 'changer@example.test'});
            const this_device = request.agent(app);
            await this_device.post('/api/auth/sign-in/username').send({username: 'changer', password: 'long enough'}).expect(200);

            const wrong = await this_device.post('/api/auth/change-password').set('Origin', ORIGIN)
                .send({currentPassword: 'not it', newPassword: 'a new password', revokeOtherSessions: true});
            expect([wrong.status, wrong.body.code]).toEqual([400, 'INVALID_PASSWORD']);

            const response = await this_device.post('/api/auth/change-password').set('Origin', ORIGIN)
                .send({currentPassword: 'long enough', newPassword: 'a new password', revokeOtherSessions: true});
            expect(response.status).toBe(200);
            expect((await this_device.get('/user/profile')).status).toBe(200);
            expect((await other_device.get('/user/profile')).status).toBe(401);
            expect(mail_to('changer@example.test').map((m) => m.subject)).toContain('Your Sequence password was changed');
        });
    });

    describe('email', function () {
        function change_email(agent, newEmail) {
            return agent.post('/api/auth/change-email').set('Origin', ORIGIN).send({newEmail, callbackURL: '/profile'});
        }

        test('a confirmed address approves the move first, then the new one confirms itself', async function () {
            const mover = await verified_account(request, app, {username: 'mover', email: 'old@example.test'});
            expect((await change_email(mover, 'New@Example.test')).status).toBe(200);
            // Nothing changes until both links are followed.
            expect((await mover.get('/user/profile')).body.email).toBe('old@example.test');

            const approval = mail_to('old@example.test').pop();
            expect(approval.subject).toBe('Approve the new email for your Sequence account');
            expect(approval.text).toContain('new@example.test');
            const approved = await mover.get(link_in(approval));
            expect([approved.status, approved.headers.location]).toEqual([302, '/profile']);

            const confirmation = mail_to('new@example.test').pop();
            expect(confirmation.subject).toBe('Confirm your email for Sequence');
            expect(link_in(confirmation)).toContain('callbackURL=%2Fprofile');
            await mover.get(link_in(confirmation)).expect(302);
            expect((await mover.get('/user/profile')).body).toMatchObject({email: 'new@example.test', email_verified: true});
        });

        test('an account without an email gets one by confirming it', async function () {
            await insert_legacy_user(database.pool, {handle: 'old_timer', name: 'Old', password: 'from before'});
            const old_timer = request.agent(app);
            await old_timer.post('/api/auth/sign-in/username').send({username: 'old_timer', password: 'from before'}).expect(200);

            expect((await change_email(old_timer, 'old.timer@example.test')).status).toBe(200);
            const confirmation = mail_to('old.timer@example.test').pop();
            await old_timer.get(link_in(confirmation)).expect(302);
            expect((await old_timer.get('/user/profile')).body).toMatchObject({email: 'old.timer@example.test', email_verified: true});

            // Now it can reset its password by email like any account.
            await request(app).post('/api/auth/request-password-reset').set('Origin', ORIGIN)
                .send({email: 'old.timer@example.test', redirectTo: '/reset-password'}).expect(200);
            expect(mail_to('old.timer@example.test').pop().subject).toBe('Reset your Sequence password');
        });

        test("can't take an address that has an account, without saying so", async function () {
            const response = await change_email(player, 'old.timer@example.test');
            expect(response.status).toBe(200);
            expect((await player.get('/user/profile')).body.email).toBe('player@example.test');
        });
    });

    describe('sessions', function () {
        test('signing in on another device signs this one out, and tells its open pages', async function () {
            const socket_server = require('../socket');
            const sent = jest.spyOn(socket_server, 'broadcast');
            const laptop = request.agent(app);
            await laptop.post('/api/auth/sign-in/username').send({username: 'player', password: 'long enough'}).expect(200);

            expect((await player.get('/user/profile')).status).toBe(401);
            expect((await laptop.get('/user/profile')).status).toBe(200);
            expect((await laptop.get('/api/auth/list-sessions')).body).toHaveLength(1);
            expect(sent).toHaveBeenCalledWith({event: 'signed_in_elsewhere', data: {handle: 'player'}});
            sent.mockRestore();

            // And back: the first device signs in again, which signs the laptop out.
            await player.post('/api/auth/sign-in/username').set('Origin', ORIGIN).send({username: 'player', password: 'long enough'}).expect(200);
            expect((await laptop.get('/user/profile')).status).toBe(401);
            expect((await player.get('/user/profile')).status).toBe(200);
        });

        test("a first sign-in doesn't announce anything", async function () {
            await verified_account(request, app, {username: 'loner', email: 'loner@example.test'});
            const socket_server = require('../socket');
            const sent = jest.spyOn(socket_server, 'broadcast');
            const agent = request.agent(app);
            // Confirming the email signed this account in once; signing in here replaces that session.
            await agent.post('/api/auth/sign-in/username').send({username: 'loner', password: 'long enough'}).expect(200);
            expect(sent).toHaveBeenCalledTimes(1);
            await agent.post('/api/auth/sign-out').set('Origin', ORIGIN).send({}).expect(200);
            await agent.post('/api/auth/sign-in/username').set('Origin', ORIGIN).send({username: 'loner', password: 'long enough'}).expect(200);
            expect(sent).toHaveBeenCalledTimes(1);
            sent.mockRestore();
        });
    });
});
