const db_user = require('../database/users');
const db_room = require('../database/rooms');
const {UserError, real_email, validate_card_deck} = require('../entity/user');
const {check_avatar} = require('../entity/avatar');

// The signed-in player's endpoints. Signing up, in and out is Better Auth's (/api/auth, see auth.js).
// Errors are JSON: {error: CODE, message}, like the table game endpoints.

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
    IMAGE_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
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
function public_profile(user, stats) {
    return {
        handle: user.handle,
        name: user.name,
        email: real_email(user.email),
        email_verified: user.email_verified,
        image: user.image,
        card_deck: user.card_deck,
        created_at: user.created_at,
        stats,
    };
}

async function signed_in_user(req) {
    const user = await db_user.get_user({handle: req.handle});
    if (user === undefined) {
        throw new UserError('NOT_SIGNED_IN', 'Sign in first.');
    }
    return user;
}

async function profile(req, res) {
    const user = await signed_in_user(req);
    res.send(public_profile(user, await db_user.stats({user_id: user.id})));
}

/** PUT /user/avatar, the picture as the raw body (PNG, JPEG or WebP): 200 {image}, the URL that now serves it. */
async function upload_avatar(req, res) {
    const user = await signed_in_user(req);
    // The raw body parser (routes/user.js) only reads the accepted types; anything else leaves the body unread.
    if (!Buffer.isBuffer(req.body)) {
        throw new UserError('UNSUPPORTED_MEDIA_TYPE', 'Choose a PNG, JPEG or WebP picture.');
    }
    const checked = check_avatar(req.body);
    if (checked.error) {
        throw new UserError(checked.error, checked.message);
    }
    const image = await db_user.set_avatar({user_id: user.id, content_type: checked.content_type, data: req.body});
    res.send({image});
}

/** DELETE /user/avatar: 204, back to the initials. */
async function remove_avatar(req, res) {
    const user = await signed_in_user(req);
    await db_user.delete_avatar({user_id: user.id});
    res.status(204).send();
}

/** GET /user/avatar/:id: anyone's avatar, as its image, or 404. Its URL changes with every upload, so it is cached. */
async function avatar(req, res) {
    const found = await db_user.get_avatar({user_id: req.params.id});
    if (found === undefined) {
        return res.status(404).send({error: 'NOT_FOUND', message: 'No such picture.'});
    }
    res.set({
        'Content-Type': found.content_type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Only ever shown as an image, never run or sniffed as anything else.
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(found.data);
}

/** PUT /user/card-deck {card_deck}: 200 {card_deck}, the deck the player's hand is shown in on every device. */
async function set_card_deck(req, res) {
    const user = await signed_in_user(req);
    const checked = validate_card_deck(req.body && req.body.card_deck);
    if (checked.error) {
        throw new UserError('INVALID_CARD_DECK', checked.error);
    }
    await db_user.set_card_deck({user_id: user.id, card_deck: checked.card_deck});
    res.send({card_deck: checked.card_deck});
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
    const user = await signed_in_user(req);
    const per_page = Math.min(positive_integer(req.query.per_page, ROOMS_PER_PAGE.default), ROOMS_PER_PAGE.max);
    const page = positive_integer(req.query.page, 1);
    const total = await db_room.count_for_user({user_id: user.id});
    const list = await db_room.list_for_user({user_id: user.id, limit: per_page, offset: (page - 1) * per_page});
    res.send({rooms: list, page, per_page, total, pages: Math.max(1, Math.ceil(total / per_page))});
}

/** GET /user/current-game: {room} for the game in progress you sat at that moved last, or {room: null}. */
async function current_game(req, res) {
    const user = await signed_in_user(req);
    res.send({room: (await db_room.current_for_user({user_id: user.id})) || null});
}

module.exports = {
    profile: handler(profile),
    upload_avatar: handler(upload_avatar),
    remove_avatar: handler(remove_avatar),
    avatar: handler(avatar),
    set_card_deck: handler(set_card_deck),
    rooms: handler(rooms),
    current_game: handler(current_game),
};
