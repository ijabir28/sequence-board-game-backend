// HTTP tests for accounts: Better Auth's endpoints under /api/auth (auth.js) and our /user ones.
// Need PostgreSQL, see database/test_database.js.
const request = require('supertest');
const {has_database, use_test_schema} = require('../database/test_database');

const describe_with_database = has_database ? describe : describe.skip;

const SESSION_COOKIE = 'sequence.session_token';

// The `name=value` of the session cookie a response sets, or undefined.
function session_cookie(response) {
    const cookies = response.headers['set-cookie'] || [];
    const cookie = cookies.find(function (c) {
        return c.startsWith(`${SESSION_COOKIE}=`);
    });
    return cookie && cookie.split(';')[0];
}

// An account made before Better Auth, as migration 0011 leaves it: placeholder email, password in auth_accounts.
async function insert_legacy_user(pool, {handle, name, password}) {
    const {hash_password} = require('../entity/user');
    const {rows} = await pool.query(
        "INSERT INTO users (handle, name, email) VALUES ($1, $2, $1 || '@no-email.invalid') RETURNING id",
        [handle, name]
    );
    await pool.query(
        "INSERT INTO auth_accounts (user_id, account_id, provider_id, password) VALUES ($1, $2, 'credential', $3)",
        [rows[0].id, String(rows[0].id), await hash_password(password)]
    );
}

// The path of the first link in an email, for supertest (links are absolute, on BETTER_AUTH_URL).
function link_in(mail) {
    const url = new URL(mail.text.match(/https?:\/\/\S+/)[0]);
    return url.pathname + url.search;
}

describe_with_database('accounts', function () {
    let database;
    let app;
    let outbox;

    // Emails sent to `to` since the outbox was last cleared.
    function mail_to(to) {
        return outbox.filter(function (mail) {
            return mail.to === to;
        });
    }

    // Signs up and confirms the email by following the emailed link; resolves to the agent, now signed in.
    async function verified_account({username, email, password = 'long enough'}) {
        await request(app).post('/api/auth/sign-up/email').send({username, name: 'Someone', email, password}).expect(200);
        const agent = request.agent(app);
        await agent.get(link_in(mail_to(email).pop())).expect(302);
        return agent;
    }

    beforeAll(async function () {
        database = await use_test_schema('user');
        app = require('../app');
        outbox = require('../mailer').outbox;
        await insert_legacy_user(database.pool, {handle: 'jabir', name: 'Jabir ibne kamal', password: 'correct horse'});
    });

    afterAll(async function () {
        await database.drop();
    });

    function sign_in(agent, body) {
        return agent.post('/api/auth/sign-in/username').send(body);
    }

    describe('POST /api/auth/sign-in/username', function () {
        test('signs in an account made before Better Auth, with its old password', async function () {
            const agent = request.agent(app);
            const response = await sign_in(agent, {username: 'jabir', password: 'correct horse'});
            expect(response.status).toBe(200);
            expect(response.body.user).toMatchObject({username: 'jabir', name: 'Jabir ibne kamal'});
            expect(response.headers['set-cookie'].join()).toMatch(/sequence\.session_token=.*HttpOnly.*SameSite=Lax/);

            const profile = await agent.get('/user/profile');
            expect(profile.body).toEqual({
                handle: 'jabir', name: 'Jabir ibne kamal', email: null, email_verified: false, image: null,
            });
        });

        test('accepts the handle in any case and with spaces', async function () {
            const response = await sign_in(request(app), {username: ' JABIR ', password: 'correct horse'});
            expect(response.status).toBe(200);
        });

        test('rejects a wrong password and an unknown handle the same way', async function () {
            for (const body of [
                {username: 'jabir', password: 'wrong'},
                {username: 'nobody', password: 'correct horse'},
            ]) {
                const response = await sign_in(request(app), body);
                expect(response.status).toBe(401);
                expect(response.body.code).toBe('INVALID_USERNAME_OR_PASSWORD');
                expect(session_cookie(response)).toBeUndefined();
            }
        });

        test('starts a new session on every sign-in', async function () {
            const agent = request.agent(app);
            const first = await sign_in(agent, {username: 'jabir', password: 'correct horse'});
            const second = await sign_in(agent, {username: 'jabir', password: 'correct horse'});
            expect(session_cookie(second)).not.toBe(session_cookie(first));
        });

        test('never sends a password hash', async function () {
            const response = await sign_in(request(app), {username: 'jabir', password: 'correct horse'});
            expect(JSON.stringify(response.body)).not.toMatch(/scrypt|password/);
        });
    });

    describe('GET /user/profile', function () {
        test('is 401 without a session instead of crashing', async function () {
            const response = await request(app).get('/user/profile');
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('NOT_SIGNED_IN');
        });

        test('is 401 with a forged session cookie', async function () {
            const response = await request(app).get('/user/profile').set('Cookie', `${SESSION_COOKIE}=forged.value`);
            expect(response.status).toBe(401);
        });
    });

    describe('POST /api/auth/sign-up/email', function () {
        const valid = {username: ' New_Player ', name: ' New ', email: 'New.Player@Example.test', password: 'long enough'};

        test('creates the account without signing in, and emails a link to confirm the address', async function () {
            const response = await request(app).post('/api/auth/sign-up/email').send(valid);
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({token: null, user: {username: 'new_player', name: 'New', email: 'new.player@example.test'}});
            expect(session_cookie(response)).toBeUndefined();

            const [mail] = mail_to('new.player@example.test');
            expect(mail.subject).toBe('Confirm your email for Sequence');
            expect(mail.text).toContain('Hi New,');
            expect(link_in(mail)).toMatch(/^\/api\/auth\/verify-email\?token=[\w.-]+&callbackURL=%2Femail-verified$/);
            expect(mail.html).toContain('Confirm email');

            const {rows} = await database.pool.query(
                "SELECT a.password FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE u.handle = 'new_player'"
            );
            expect(rows[0].password).toMatch(/^scrypt\$/);
        });

        test('refuses to sign in until the email is confirmed, and sends the link again', async function () {
            outbox.length = 0;
            const response = await sign_in(request(app), {username: 'new_player', password: 'long enough'});
            expect(response.status).toBe(403);
            expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
            expect(response.body.message).toContain('n•••••••••@example.test');
            expect(session_cookie(response)).toBeUndefined();
            expect(mail_to('new.player@example.test')).toHaveLength(1);

            // Asking again straight away doesn't send another.
            await sign_in(request(app), {username: 'new_player', password: 'long enough'}).expect(403);
            expect(mail_to('new.player@example.test')).toHaveLength(1);
        });

        test("the emailed link confirms the address, signs in and opens the frontend's page", async function () {
            const agent = request.agent(app);
            const response = await agent.get(link_in(mail_to('new.player@example.test').pop()));
            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('/email-verified');
            expect(session_cookie(response)).toBeDefined();
            expect((await agent.get('/user/profile')).body).toMatchObject({handle: 'new_player', email_verified: true});

            expect((await sign_in(request(app), {username: 'new_player', password: 'long enough'})).status).toBe(200);
        });

        test('a broken or forged link says so on the same page', async function () {
            const response = await request(app).get('/api/auth/verify-email?token=forged&callbackURL=%2Femail-verified');
            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('/email-verified?error=INVALID_TOKEN');
        });

        test('looks the same for a registered email, which only its owner hears about', async function () {
            outbox.length = 0;
            const response = await request(app).post('/api/auth/sign-up/email')
                .send(Object.assign({}, valid, {username: 'someone_else', email: 'NEW.PLAYER@example.test'}));
            expect(response.status).toBe(200);
            expect(response.body.token).toBeNull();

            const {rows} = await database.pool.query("SELECT count(*) FROM users WHERE handle = 'someone_else'");
            expect(rows[0].count).toBe('0');
            const [mail] = mail_to('new.player@example.test');
            expect(mail.subject).toBe('You already have a Sequence account');
            expect(mail.text).toContain('"new_player"');
        });

        test('refuses a taken handle in any case', async function () {
            const response = await request(app).post('/api/auth/sign-up/email')
                .send(Object.assign({}, valid, {username: 'JABIR', email: 'other@example.test'}));
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('USERNAME_IS_ALREADY_TAKEN');
        });

        test('explains which field is invalid, and creates nothing', async function () {
            const cases = [
                [{username: 'a'}, 'USERNAME_TOO_SHORT'],
                [{username: 'has space'}, 'INVALID_USERNAME'],
                [{name: '   '}, 'INVALID_NAME'],
                [{name: 'x'.repeat(11)}, 'INVALID_NAME'],
                [{email: 'not an email'}, 'VALIDATION_ERROR'],
                [{password: 'short'}, 'PASSWORD_TOO_SHORT'],
            ];
            for (const [fields, code] of cases) {
                const body = Object.assign({}, valid, {username: 'valid_one', email: 'valid@example.test'}, fields);
                const response = await request(app).post('/api/auth/sign-up/email').send(body);
                expect([response.status, response.body.code]).toEqual([400, code]);
                expect(typeof response.body.message).toBe('string');
            }
            const {rows} = await database.pool.query("SELECT count(*) FROM users WHERE handle = 'valid_one'");
            expect(rows[0].count).toBe('0');
        });
    });

    describe('password reset', function () {
        const email = 'forgetful@example.test';
        let signed_in;

        beforeAll(async function () {
            signed_in = await verified_account({username: 'forgetful', email});
        });

        function request_reset(address) {
            return request(app).post('/api/auth/request-password-reset')
                .set('Origin', 'http://localhost:5173')
                .send({email: address, redirectTo: '/reset-password'});
        }

        test('answers the same for unknown emails, and sends nothing', async function () {
            outbox.length = 0;
            const response = await request_reset('nobody@example.test');
            expect(response.status).toBe(200);
            expect(outbox).toHaveLength(0);
        });

        test('emails a single-use link that sets a new password and signs out every device', async function () {
            outbox.length = 0;
            expect((await request_reset(email)).status).toBe(200);
            const [mail] = mail_to(email);
            expect(mail.subject).toBe('Reset your Sequence password');

            // The link hands the token to the frontend's page.
            const opened = await request(app).get(link_in(mail));
            expect(opened.status).toBe(302);
            const page = new URL(opened.headers.location, 'http://localhost');
            expect(page.pathname).toBe('/reset-password');
            const token = page.searchParams.get('token');

            const reset = await request(app).post('/api/auth/reset-password').set('Origin', 'http://localhost:5173')
                .send({token, newPassword: 'brand new password'});
            expect(reset.status).toBe(200);
            expect(mail_to(email).map((m) => m.subject)).toContain('Your Sequence password was changed');

            expect((await signed_in.get('/user/profile')).status).toBe(401);
            expect((await sign_in(request(app), {username: 'forgetful', password: 'long enough'})).status).toBe(401);
            expect((await sign_in(request(app), {username: 'forgetful', password: 'brand new password'})).status).toBe(200);

            const again = await request(app).post('/api/auth/reset-password').set('Origin', 'http://localhost:5173')
                .send({token, newPassword: 'another password'});
            expect(again.status).toBe(400);
            expect(again.body.code).toBe('INVALID_TOKEN');
        });

        test('keeps the password rules', async function () {
            outbox.length = 0;
            await request_reset(email);
            const page = new URL((await request(app).get(link_in(mail_to(email)[0]))).headers.location, 'http://localhost');
            const response = await request(app).post('/api/auth/reset-password').set('Origin', 'http://localhost:5173')
                .send({token: page.searchParams.get('token'), newPassword: 'short'});
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('PASSWORD_TOO_SHORT');
        });

        test('confirms an unconfirmed email, since the link went there', async function () {
            await request(app).post('/api/auth/sign-up/email')
                .send({username: 'unconfirmed', name: 'U', email: 'unconfirmed@example.test', password: 'long enough'});
            outbox.length = 0;
            await request_reset('unconfirmed@example.test');
            const page = new URL((await request(app).get(link_in(mail_to('unconfirmed@example.test')[0]))).headers.location, 'http://localhost');
            await request(app).post('/api/auth/reset-password').set('Origin', 'http://localhost:5173')
                .send({token: page.searchParams.get('token'), newPassword: 'chosen again'}).expect(200);
            expect((await sign_in(request(app), {username: 'unconfirmed', password: 'chosen again'})).status).toBe(200);
        });

        test('never emails the placeholder of an account without an email', async function () {
            outbox.length = 0;
            expect((await request_reset('jabir@no-email.invalid')).status).toBe(200);
            expect(outbox).toHaveLength(0);
        });
    });

    describe('POST /api/auth/sign-out', function () {
        test('ends the session on the server', async function () {
            const agent = request.agent(app);
            const cookie = session_cookie(await sign_in(agent, {username: 'jabir', password: 'correct horse'}));
            expect((await request(app).get('/user/profile').set('Cookie', cookie)).status).toBe(200);

            expect((await agent.post('/api/auth/sign-out').set('Origin', 'http://localhost:5173')).status).toBe(200);
            expect((await agent.get('/user/profile')).status).toBe(401);
            // A copy of the old cookie is useless too: the session row is gone.
            expect((await request(app).get('/user/profile').set('Cookie', cookie)).status).toBe(401);
        });

        test('refuses requests from other sites', async function () {
            const agent = request.agent(app);
            await sign_in(agent, {username: 'jabir', password: 'correct horse'});
            const response = await agent.post('/api/auth/sign-out').set('Origin', 'https://evil.example');
            expect(response.status).toBe(403);
            expect((await agent.get('/user/profile')).status).toBe(200);
        });
    });
});

describe_with_database('sign-in rate limit', function () {
    let database;
    let app;

    beforeAll(async function () {
        jest.resetModules();
        database = await use_test_schema('limit');
        app = require('../app');
    });

    afterAll(async function () {
        await database.drop();
    });

    test('blocks an address after 10 failed sign-ins', async function () {
        for (let attempt = 0; attempt < 10; attempt++) {
            const response = await request(app).post('/api/auth/sign-in/username').send({username: 'jabir', password: 'guess'});
            expect(response.status).toBe(401);
        }
        const blocked = await request(app).post('/api/auth/sign-in/username').send({username: 'jabir', password: 'guess'});
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
    });
});
