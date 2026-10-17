// Account rules and password hashing. No I/O besides the CPU-bound hash, so it is easy to test.
const crypto = require('crypto');
const {promisify} = require('util');

const scrypt = promisify(crypto.scrypt);

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
// New accounts' display names are short, so they fit in turn panels and seat lists. (The users table allows up to
// 50, so accounts made before keep their names.)
const NAME_MAX_LENGTH = 10;
const PASSWORD_MIN_LENGTH = 8;
// Hashing cost grows with input length; cap it so a huge password can't tie up the server.
const PASSWORD_MAX_LENGTH = 200;
// Accounts made before emails were asked for have `<handle>@no-email.invalid` (migration 0011). The reserved
// `.invalid` domain can't receive mail, so these are treated as having no email at all.
const PLACEHOLDER_EMAIL_DOMAIN = '@no-email.invalid';

// scrypt cost parameters. They are stored in every hash, so they can be raised later without breaking
// existing accounts. N = 2^15 needs 32 MiB, just over Node's default limit, hence MAX_MEMORY.
const SCRYPT = {N: 2 ** 15, r: 8, p: 1};
const MAX_MEMORY = 64 * 1024 * 1024;
const KEY_LENGTH = 64;

class UserError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// A card deck's id, as the frontend names its decks (`classic`, `four-colour`). Migration 0014 checks the same shape.
const CARD_DECK_PATTERN = /^[a-z0-9-]{1,32}$/;

/** {card_deck}, or {error} when it isn't a deck id. */
function validate_card_deck(card_deck) {
    if (typeof card_deck !== 'string' || !CARD_DECK_PATTERN.test(card_deck)) {
        return {error: 'Choose one of the card decks.'};
    }
    return {card_deck};
}

function normalize_handle(handle) {
    return typeof handle === 'string' ? handle.trim().toLowerCase() : '';
}

// {name} trimmed, or {error} explaining what a display name must be. Better Auth checks handles, emails and
// passwords itself (auth.js gives it the rules above).
function validate_name(name) {
    const clean_name = typeof name === 'string' ? name.trim() : '';
    if (clean_name.length === 0 || clean_name.length > NAME_MAX_LENGTH) {
        return {error: `Enter a display name of up to ${NAME_MAX_LENGTH} characters.`};
    }
    return {name: clean_name};
}

/** The user's email, or null for the placeholder of an account that has none yet. */
function real_email(email) {
    return typeof email === 'string' && !email.endsWith(PLACEHOLDER_EMAIL_DOMAIN) ? email : null;
}

async function hash_password(password, {N, r, p} = SCRYPT) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, {N, r, p, maxmem: MAX_MEMORY});
    return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verify_password(password, stored_hash) {
    if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) {
        return false;
    }
    const [algorithm, N, r, p, salt, expected] = String(stored_hash).split('$');
    if (algorithm !== 'scrypt' || expected === undefined) {
        return false;
    }
    const expected_key = Buffer.from(expected, 'base64');
    const key = await scrypt(password, Buffer.from(salt, 'base64'), expected_key.length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: MAX_MEMORY,
    });
    return crypto.timingSafeEqual(key, expected_key);
}

module.exports = {
    UserError, HANDLE_PATTERN, NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH,
    PLACEHOLDER_EMAIL_DOMAIN, normalize_handle, validate_name, validate_card_deck, real_email, hash_password, verify_password,
};
