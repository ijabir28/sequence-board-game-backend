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

describe_with_database('accounts', function () {
    let database;
    let app;

    beforeAll(async function () {
        database = await use_test_schema('user');
        app = require('../app');
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

        test('creates the account and signs it in, and the password works afterwards', async function () {
            const agent = request.agent(app);
            const response = await agent.post('/api/auth/sign-up/email').send(valid);
            expect(response.status).toBe(200);
            expect(response.body.user).toMatchObject({username: 'new_player', name: 'New', email: 'new.player@example.test'});
            expect((await agent.get('/user/profile')).body).toMatchObject({handle: 'new_player', email: 'new.player@example.test'});

            expect((await sign_in(request(app), {username: 'new_player', password: 'long enough'})).status).toBe(200);
            const {rows} = await database.pool.query(
                "SELECT a.password FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE u.handle = 'new_player'"
            );
            expect(rows[0].password).toMatch(/^scrypt\$/);
        });

        test('refuses a taken handle in any case, and a taken email', async function () {
            const handle = await request(app).post('/api/auth/sign-up/email')
                .send(Object.assign({}, valid, {username: 'JABIR', email: 'other@example.test'}));
            expect(handle.status).toBe(400);
            expect(handle.body.code).toBe('USERNAME_IS_ALREADY_TAKEN');

            const email = await request(app).post('/api/auth/sign-up/email')
                .send(Object.assign({}, valid, {username: 'someone_else'}));
            expect(email.status).toBe(422);
            expect(email.body.code).toBe('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL');
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
