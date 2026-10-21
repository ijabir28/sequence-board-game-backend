const {pool, transaction} = require('./pool');
const {avatar_url} = require('../entity/avatar');

// Better Auth (auth.js) creates and changes accounts; the game reads them, and keeps their avatars.
const PUBLIC_COLUMNS = 'id, handle, name, email, email_verified, image, card_deck, board_style, created_at';

async function get_user({handle}) {
    if (typeof handle !== 'string') {
        return undefined;
    }
    const {rows} = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE handle = $1`, [handle]);
    return rows[0];
}

/** How the user's table games went: {played, won} counts finished games, {playing} the ones in progress. */
async function stats({user_id}) {
    const {rows} = await pool.query(
        `SELECT count(*) FILTER (WHERE games.finished_at IS NOT NULL)::INT AS played,
                count(*) FILTER (WHERE games.winner_team = room_seats.team AND room_seats.forfeited_at IS NULL)::INT AS won,
                count(*) FILTER (WHERE games.finished_at IS NULL)::INT AS playing
         FROM room_seats JOIN games ON games.room_id = room_seats.room_id
         WHERE room_seats.user_id = $1`,
        [user_id]
    );
    return rows[0];
}

/** Replaces the user's avatar and points users.image at it. Resolves to the new image URL. */
async function set_avatar({user_id, content_type, data}) {
    return transaction(async function (client) {
        const {rows: [avatar]} = await client.query(
            `INSERT INTO user_avatars (user_id, content_type, data) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET content_type = $2, data = $3, updated_at = now()
             RETURNING updated_at`,
            [user_id, content_type, data]
        );
        const image = avatar_url(user_id, avatar.updated_at);
        await client.query('UPDATE users SET image = $2, updated_at = now() WHERE id = $1', [user_id, image]);
        return image;
    });
}

async function delete_avatar({user_id}) {
    await transaction(async function (client) {
        await client.query('DELETE FROM user_avatars WHERE user_id = $1', [user_id]);
        await client.query('UPDATE users SET image = NULL, updated_at = now() WHERE id = $1', [user_id]);
    });
}

/** {content_type, data, updated_at}, or undefined when the user has no avatar. */
async function get_avatar({user_id}) {
    if (!/^\d+$/.test(String(user_id))) {
        return undefined;
    }
    const {rows} = await pool.query('SELECT content_type, data, updated_at FROM user_avatars WHERE user_id = $1', [user_id]);
    return rows[0];
}

async function set_card_deck({user_id, card_deck}) {
    await pool.query('UPDATE users SET card_deck = $2, updated_at = now() WHERE id = $1', [user_id, card_deck]);
}

async function set_board_style({user_id, board_style}) {
    await pool.query('UPDATE users SET board_style = $2, updated_at = now() WHERE id = $1', [user_id, board_style]);
}

/**
 * `count` different bots, picked at random, none of them with a handle in `except`: [{user_id, handle, name}]. Bots are
 * made by migration 0018.
 */
async function random_bots({count, except = [], client = pool}) {
    const {rows} = await client.query(
        'SELECT id AS user_id, handle, name FROM users WHERE is_bot AND handle <> ALL($2) ORDER BY random() LIMIT $1',
        [count, except]
    );
    return rows;
}

/** The user's id for a handle, or undefined. */
async function id_of({handle, client = pool}) {
    const {rows} = await client.query('SELECT id FROM users WHERE handle = $1', [handle]);
    return rows[0] === undefined ? undefined : rows[0].id;
}

module.exports = {random_bots, id_of, get_user, stats, set_avatar, delete_avatar, get_avatar, set_card_deck, set_board_style};
