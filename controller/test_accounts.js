// Helpers for specs that sign players in through Better Auth (auth.js).
// Required once, with the app: a spec that later resets the module registry (to simulate a restart) would otherwise
// read a fresh, empty outbox while the app it already holds keeps sending to this one.
const {outbox} = require('../mailer');

const SESSION_COOKIE = 'sequence.session_token';
// Better Auth refuses state-changing requests from other origins; browsers send this themselves.
const ORIGIN = 'http://localhost:5173';

// The `name=value` of the session cookie a response sets, or undefined.
function session_cookie(response) {
    const cookies = response.headers['set-cookie'] || [];
    const cookie = cookies.find(function (c) {
        return c.startsWith(`${SESSION_COOKIE}=`);
    });
    return cookie && cookie.split(';')[0];
}

// The path of the first link in an email, for supertest (links are absolute, on BETTER_AUTH_URL).
function link_in(mail) {
    const url = new URL(mail.text.match(/https?:\/\/\S+/)[0]);
    return url.pathname + url.search;
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

// Emails in the test outbox sent to `to`.
function mail_to(to) {
    return outbox.filter(function (mail) {
        return mail.to === to;
    });
}

// Signs up and confirms the email with the emailed link; resolves to an agent signed in as the new account.
async function verified_account(request, app, {username, email, name = 'Someone', password = 'long enough'}) {
    await request(app).post('/api/auth/sign-up/email').send({username, name, email, password}).expect(200);
    const agent = request.agent(app);
    await agent.get(link_in(mail_to(email).pop())).expect(302);
    return agent;
}

module.exports = {SESSION_COOKIE, ORIGIN, session_cookie, link_in, insert_legacy_user, mail_to, verified_account};
