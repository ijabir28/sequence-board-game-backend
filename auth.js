// Accounts and sessions, run by Better Auth (https://better-auth.com) on our own PostgreSQL (Neon in production).
// It serves its endpoints under /api/auth (see app.js); docs/api.md lists the ones the frontend uses.
//
// Better Auth's tables are mapped onto ours, so accounts made before it keep working:
//   user         -> users (the handle is the username plugin's `username`; ids stay BIGINT, see `generateId`)
//   account      -> auth_accounts (the scrypt password hash moved here from users.password_hash)
//   session      -> auth_sessions
//   verification -> auth_verifications
// Migration 0011 creates them; Better Auth's own migration tool is not used.
const {betterAuth} = require('better-auth');
const {APIError, createAuthMiddleware, createEmailVerificationToken, isAPIError} = require('better-auth/api');
const {username} = require('better-auth/plugins');
const {fromNodeHeaders} = require('better-auth/node');
const {pool} = require('./database/pool');
const {HANDLE_PATTERN, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, normalize_handle, validate_name, real_email, hash_password,
    verify_password} = require('./entity/user');
const emails = require('./entity/emails');
const {send_in_background} = require('./mailer');

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const VERIFY_EMAIL_SECONDS = DAY_SECONDS;
const RESET_PASSWORD_SECONDS = HOUR_SECONDS;
// Where emailed links land in the frontend (src/App.tsx). Relative, so they stay on BETTER_AUTH_URL.
const EMAIL_VERIFIED_PAGE = '/email-verified';
const RESET_PASSWORD_PAGE = '/reset-password';
// A refused sign-in re-sends the verification link, but at most this often per account.
const RESEND_VERIFICATION_MS = 60 * 1000;

// The secret signs session cookies and verification tokens, and the tokens game sockets use to say who they are
// (controller/presence.js).
function session_secret() {
    const secret = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET;
    if (secret) {
        return secret;
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('SESSION_SECRET must be set in production.');
    }
    return 'development-only-session-secret-never-use-in-production';
}

// Where players open the app. Links in emails point here, and requests from other origins are refused. In
// development that is the Vite server, which proxies /api to this backend.
function base_url() {
    if (process.env.BETTER_AUTH_URL) {
        return process.env.BETTER_AUTH_URL;
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('BETTER_AUTH_URL must be set in production (the address players open, e.g. https://….onrender.com).');
    }
    return 'http://localhost:5173';
}

function trusted_origins() {
    const origins = [new URL(base_url()).origin];
    if (process.env.NODE_ENV !== 'production') {
        // The backend itself, for the legacy page and for trying the API directly.
        origins.push('http://localhost:3000');
    }
    return origins;
}

// Before sign-up and profile changes. Display names follow our rule (entity/user.js), not Better Auth's, which accepts
// any string. Avatars are uploaded to PUT /user/avatar, which sets `image`; a client setting it to any URL it likes
// (a tracking pixel, say) is refused.
const check_user_fields = createAuthMiddleware(async function (ctx) {
    if (ctx.path !== '/sign-up/email' && ctx.path !== '/update-user') return;
    if (ctx.body.image !== undefined) {
        throw new APIError('BAD_REQUEST', {code: 'IMAGE_READ_ONLY', message: 'Upload a picture to change your avatar.'});
    }
    if (ctx.path === '/update-user' && ctx.body.name === undefined) return;
    const result = validate_name(ctx.body.name);
    if (result.error) {
        throw new APIError('BAD_REQUEST', {code: 'INVALID_NAME', message: result.error});
    }
    ctx.body.name = result.name;
});

function api_url(path) {
    return `${base_url()}/api/auth${path}`;
}

// The link that confirms `email`, as Better Auth's own /send-verification-email builds it.
async function verification_url(email) {
    const token = await createEmailVerificationToken(session_secret(), email, undefined, VERIFY_EMAIL_SECONDS);
    return api_url(`/verify-email?token=${token}&callbackURL=${encodeURIComponent(EMAIL_VERIFIED_PAGE)}`);
}

function send_verification_email(user, url) {
    send_in_background(Object.assign(
        {to: user.email}, emails.verify_email({name: user.name, url, hours: VERIFY_EMAIL_SECONDS / HOUR_SECONDS})
    ));
}

// `jabir@example.com` → `j••••@example.com`, to say where a link went without showing the whole address.
function mask_email(email) {
    const [local, domain] = email.split('@');
    return `${local[0]}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

const last_resent = new Map();

// New accounts must confirm their email before they get a session. Accounts made before emails were asked for have
// no real address to confirm, so they are let in (they can add one from their profile). Better Auth's own
// requireEmailVerification can't make that exception, hence this hook on every new session.
async function require_verified_email(session) {
    const {rows: [user]} = await pool.query('SELECT name, email, email_verified FROM users WHERE id = $1', [session.userId]);
    if (!user || user.email_verified || real_email(user.email) === null) return;

    const last = last_resent.get(String(session.userId));
    if (last === undefined || Date.now() - last > RESEND_VERIFICATION_MS) {
        last_resent.set(String(session.userId), Date.now());
        send_verification_email(user, await verification_url(user.email));
    }
    throw new APIError('FORBIDDEN', {
        code: 'EMAIL_NOT_VERIFIED',
        message: `Confirm your email first: open the link we sent to ${mask_email(user.email)}.`,
    });
}

// One device at a time: a new session (signing in, or confirming an email, which signs in) ends the account's
// sessions everywhere else. Sessions aren't cached in cookies, so the other devices are signed out on their next
// request; the broadcast tells their open pages now, so they can say why (each page checks its own session).
async function end_other_sessions(session) {
    const {rowCount} = await pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND id <> $2', [session.userId, session.id]);
    if (rowCount === 0) return;
    const {rows: [user]} = await pool.query('SELECT handle FROM users WHERE id = $1', [session.userId]);
    if (user) require('./socket').broadcast({event: 'signed_in_elsewhere', data: {handle: user.handle}});
}

// After a successful password change, tell the account's address, in case it wasn't its owner.
const notify_password_change = createAuthMiddleware(async function (ctx) {
    if (ctx.path !== '/change-password' || isAPIError(ctx.context.returned) || !ctx.context.session) return;
    const {user} = ctx.context.session;
    send_in_background(Object.assign({to: user.email}, emails.password_changed({name: user.name})));
});

const auth = betterAuth({
    appName: 'Sequence',
    baseURL: base_url(),
    basePath: '/api/auth',
    secret: session_secret(),
    trustedOrigins: trusted_origins(),
    database: pool,
    user: {
        modelName: 'users',
        fields: {emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at'},
        // POST /change-email {newEmail, callbackURL}. The new address gets a link, and the email only changes when it
        // is opened. An account whose current address is confirmed must approve the move from it first, so a
        // borrowed session can't quietly take the account over. Accounts with the placeholder go straight to the
        // link for the new address.
        changeEmail: {
            enabled: true,
            sendChangeEmailConfirmation: async function ({user, newEmail, url}) {
                send_in_background(Object.assign({to: user.email}, emails.approve_email_change({
                    name: user.name, new_email: newEmail, url, hours: VERIFY_EMAIL_SECONDS / HOUR_SECONDS,
                })));
            },
        },
    },
    account: {
        modelName: 'auth_accounts',
        fields: {
            accountId: 'account_id', providerId: 'provider_id', userId: 'user_id', accessToken: 'access_token',
            refreshToken: 'refresh_token', idToken: 'id_token', accessTokenExpiresAt: 'access_token_expires_at',
            refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at',
        },
    },
    session: {
        modelName: 'auth_sessions',
        fields: {
            expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', userId: 'user_id',
            createdAt: 'created_at', updatedAt: 'updated_at',
        },
        // Like before: a week of inactivity signs a user out. Each day of use pushes the expiry back.
        expiresIn: WEEK_SECONDS,
        updateAge: DAY_SECONDS,
    },
    verification: {
        modelName: 'auth_verifications',
        fields: {expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at'},
    },
    emailAndPassword: {
        enabled: true,
        minPasswordLength: PASSWORD_MIN_LENGTH,
        maxPasswordLength: PASSWORD_MAX_LENGTH,
        // Sign-up never signs in: the account has to confirm its email first (require_verified_email). That also means
        // a sign-up with a registered email looks the same as a new one, so emails can't be probed.
        autoSignIn: false,
        onExistingUserSignUp: async function ({user}) {
            send_in_background(Object.assign({to: user.email}, emails.existing_account({
                name: user.name, handle: user.username, sign_in_url: `${base_url()}/signin`,
            })));
        },
        // The emailed link opens Better Auth's /reset-password/:token, which sends the player on to the frontend's
        // RESET_PASSWORD_PAGE with the token, where they choose the new password.
        sendResetPassword: async function ({user, url}) {
            send_in_background(Object.assign({to: user.email}, emails.reset_password({
                name: user.name, url, minutes: RESET_PASSWORD_SECONDS / 60,
            })));
        },
        resetPasswordTokenExpiresIn: RESET_PASSWORD_SECONDS,
        // A reset is what someone does when they think their password leaked: sign out every device.
        revokeSessionsOnPasswordReset: true,
        onPasswordReset: async function ({user}) {
            // The link was emailed to this address, so following it proves the player receives mail there.
            await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
            send_in_background(Object.assign({to: user.email}, emails.password_changed({name: user.name})));
        },
        // Our own scrypt format (entity/user.js), so hashes from before Better Auth still verify.
        password: {
            hash: hash_password,
            verify: function ({hash, password}) {
                return verify_password(password, hash);
            },
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async function ({user, url}) {
            // Links land on our page unless the request named another one of ours (the profile does, for a new
            // email); Better Auth has already checked that it is relative or on a trusted origin.
            const link = new URL(url);
            if (link.searchParams.get('callbackURL') === '/') {
                link.searchParams.set('callbackURL', EMAIL_VERIFIED_PAGE);
            }
            send_verification_email(user, link.toString());
        },
        expiresIn: VERIFY_EMAIL_SECONDS,
        // Opening the link signs the player in, so confirming lands them in the lobby.
        autoSignInAfterVerification: true,
    },
    databaseHooks: {
        session: {create: {before: require_verified_email, after: end_other_sessions}},
    },
    plugins: [
        // Players sign in with their handle. The display name is the user's `name`, so no displayUsername.
        username({
            displayUsername: false,
            // Games, seats and socket tokens refer to players by handle, so it never changes.
            immutableUsername: true,
            schema: {user: {fields: {username: 'handle'}}},
            minUsernameLength: 3,
            maxUsernameLength: 20,
            usernameNormalization: normalize_handle,
            // Validated as typed on sign-up and sign-in, so the pattern is checked on the normalised form here.
            usernameValidator: function (handle) {
                return HANDLE_PATTERN.test(normalize_handle(handle));
            },
        }),
    ],
    hooks: {before: check_user_fields, after: notify_password_change},
    advanced: {
        cookiePrefix: 'sequence',
        // Refuse requests from origins outside trustedOrigins. Better Auth skips this under NODE_ENV=test unless
        // told otherwise, so the specs check what production does.
        disableOriginCheck: false,
        // users.id is a BIGINT identity: rooms, seats and turns reference it.
        database: {generateId: 'serial'},
    },
    telemetry: {enabled: false},
});

/**
 * Express middleware: puts the signed-in user (Better Auth's user, with `username` as the handle) on `req.user` and
 * their handle on `req.handle`, both undefined without a session. When Better Auth extends the session it sends a
 * fresh cookie, which is passed on.
 */
function load_session(req, res, next) {
    auth.api.getSession({headers: fromNodeHeaders(req.headers), returnHeaders: true})
        .then(function ({headers, response}) {
            const cookies = headers && headers.getSetCookie();
            if (cookies && cookies.length > 0) {
                res.append('Set-Cookie', cookies);
            }
            req.user = response ? response.user : undefined;
            req.handle = req.user ? req.user.username : undefined;
            next();
        })
        .catch(next);
}

module.exports = {auth, load_session, session_secret, EMAIL_VERIFIED_PAGE, RESET_PASSWORD_PAGE};
