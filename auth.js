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
const {APIError, createAuthMiddleware} = require('better-auth/api');
const {username} = require('better-auth/plugins');
const {fromNodeHeaders} = require('better-auth/node');
const {pool} = require('./database/pool');
const {HANDLE_PATTERN, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, normalize_handle, validate_name, hash_password, verify_password} =
    require('./entity/user');

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

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

// Display names follow our rule (entity/user.js), not Better Auth's, which accepts any string.
const check_display_name = createAuthMiddleware(async function (ctx) {
    if (ctx.path !== '/sign-up/email' && ctx.path !== '/update-user') return;
    if (ctx.path === '/update-user' && ctx.body.name === undefined) return;
    const result = validate_name(ctx.body.name);
    if (result.error) {
        throw new APIError('BAD_REQUEST', {code: 'INVALID_NAME', message: result.error});
    }
    ctx.body.name = result.name;
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
        // Our own scrypt format (entity/user.js), so hashes from before Better Auth still verify.
        password: {
            hash: hash_password,
            verify: function ({hash, password}) {
                return verify_password(password, hash);
            },
        },
    },
    plugins: [
        // Players sign in with their handle. The display name is the user's `name`, so no displayUsername.
        username({
            displayUsername: false,
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
    hooks: {before: check_display_name},
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

module.exports = {auth, load_session, session_secret};
