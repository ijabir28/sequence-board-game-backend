const db_user = require('../database/users');
const db_room = require('../database/rooms');
const {UserError, real_email} = require('../entity/user');

// The signed-in player's endpoints. Signing up, in and out is Better Auth's (/api/auth, see auth.js).
// Errors are JSON: {error: CODE, message}, like the table game endpoints.

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
};

function send_error(res, e) {
    if (e instanceof UserError) {
        return res.status(STATUS_BY_ERROR[e.code] || 400).send({error: e.code, message: e.message});
    }
    console.error(e);
    res.status(500).send({error: 'SERVER_ERROR', message: 'Something went wrong on the server.'});
}

// Express 4 doesn't catch rejected promises, so async handlers report their own errors.
function handler(action) {
    return function (req, res) {
        action(req, res).catch(function (e) {
            send_error(res, e);
        });
    };
}

// What the frontend knows about the signed-in player. `email` is null for an account that has none yet.
function public_profile(user) {
    return {
        handle: user.handle,
        name: user.name,
        email: real_email(user.email),
        email_verified: user.email_verified,
        image: user.image,
    };
}

async function profile(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new UserError('NOT_SIGNED_IN', 'Sign in first.');
    }
    res.send(public_profile(user));
}

// The signed-in user's tables, newest first: where they sat and how far each game got.
const ROOMS_PER_PAGE = {default: 10, max: 50};

// A positive whole number from the query string, or `fallback` when it is missing or not one.
function positive_integer(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 ? number : fallback;
}

/** GET /user/rooms?page=1&per_page=10: one page of the user's tables, newest first, with the totals for paging. */
async function rooms(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new UserError('NOT_SIGNED_IN', 'Sign in first.');
    }
    const per_page = Math.min(positive_integer(req.query.per_page, ROOMS_PER_PAGE.default), ROOMS_PER_PAGE.max);
    const page = positive_integer(req.query.page, 1);
    const total = await db_room.count_for_user({user_id: user.id});
    const list = await db_room.list_for_user({user_id: user.id, limit: per_page, offset: (page - 1) * per_page});
    res.send({rooms: list, page, per_page, total, pages: Math.max(1, Math.ceil(total / per_page))});
}

/** GET /user/current-game: {room} for the game in progress you sat at that moved last, or {room: null}. */
async function current_game(req, res) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new UserError('NOT_SIGNED_IN', 'Sign in first.');
    }
    res.send({room: (await db_room.current_for_user({user_id: user.id})) || null});
}

module.exports = {
    profile: handler(profile),
    rooms: handler(rooms),
    current_game: handler(current_game),
};
