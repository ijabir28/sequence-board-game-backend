const {pool} = require('./pool');

// Friendships and table invitations (migration 0022). A pair of players has at most one `friendships` row: `pending`
// while the addressee hasn't answered, `accepted` once they have. Declining, cancelling and unfriending delete it.
// Every function takes an optional `client`, so callers can run several in one transaction (see pool.js).

const PLAYER_COLUMNS = 'users.handle, users.name, users.image';

/** {id, handle, name, image, is_bot} for a handle, or undefined. */
async function player({handle, client = pool}) {
    if (typeof handle !== 'string') {
        return undefined;
    }
    const {rows} = await client.query(`SELECT users.id, ${PLAYER_COLUMNS}, users.is_bot FROM users WHERE handle = $1`, [handle]);
    return rows[0];
}

/** How many requests the player has sent that nobody has answered yet. */
async function count_outgoing({user_id, client = pool}) {
    const {rows} = await client.query(
        "SELECT count(*)::INT AS total FROM friendships WHERE requester_id = $1 AND status = 'pending'",
        [user_id]
    );
    return rows[0].total;
}

/**
 * How `user_id` and `other_id` stand: 'self', 'friends', 'outgoing' (user_id asked, no answer yet), 'incoming'
 * (other_id asked) or 'none'. `lock` holds the row until the transaction ends.
 */
async function relationship({user_id, other_id, client = pool, lock = false}) {
    if (String(user_id) === String(other_id)) {
        return 'self';
    }
    const {rows} = await client.query(
        `SELECT requester_id, status FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
         ${lock ? 'FOR UPDATE' : ''}`,
        [user_id, other_id]
    );
    if (rows[0] === undefined) return 'none';
    if (rows[0].status === 'accepted') return 'friends';
    return String(rows[0].requester_id) === String(user_id) ? 'outgoing' : 'incoming';
}

/** `requester_id` asks `addressee_id` to be friends. Call after relationship() said 'none'. */
async function request({requester_id, addressee_id, client = pool}) {
    await client.query('INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)', [requester_id, addressee_id]);
}

/** `addressee_id` accepts `requester_id`'s request. Resolves to whether there was one to accept. */
async function accept({requester_id, addressee_id, client = pool}) {
    const {rowCount} = await client.query(
        `UPDATE friendships SET status = 'accepted', accepted_at = now()
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
        [requester_id, addressee_id]
    );
    return rowCount > 0;
}

/**
 * Deletes the pair's row in `status` (a pending request either way, or a friendship). Resolves to whether there was
 * one. Ending a friendship also drops the invitations either of them sent the other.
 */
async function remove({user_id, other_id, status, client = pool}) {
    const {rowCount} = await client.query(
        `DELETE FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)) AND status = $3`,
        [user_id, other_id, status]
    );
    if (rowCount > 0 && status === 'accepted') {
        await client.query(
            `DELETE FROM table_invitations
             WHERE (inviter_id = $1 AND invitee_id = $2) OR (inviter_id = $2 AND invitee_id = $1)`,
            [user_id, other_id]
        );
    }
    return rowCount > 0;
}

/**
 * The player's friends, by name: [{handle, name, image, since, playing}]. `playing` is the code of a table game in
 * progress they have a seat at (the one that moved last), or null.
 */
async function list_friends({user_id, client = pool}) {
    const {rows} = await client.query(
        `SELECT ${PLAYER_COLUMNS}, friend_links.accepted_at AS since,
                (SELECT games.room_id FROM room_seats JOIN games ON games.room_id = room_seats.room_id
                 WHERE room_seats.user_id = users.id AND room_seats.forfeited_at IS NULL AND games.finished_at IS NULL
                 ORDER BY games.updated_at DESC LIMIT 1) AS playing
         FROM friend_links JOIN users ON users.id = friend_links.friend_id
         WHERE friend_links.user_id = $1
         ORDER BY lower(users.name), users.handle`,
        [user_id]
    );
    return rows;
}

/** Requests waiting on either side: {incoming: [{handle, name, image, sent_at}], outgoing: [...]}, newest first. */
async function list_requests({user_id, client = pool}) {
    const {rows} = await client.query(
        `SELECT ${PLAYER_COLUMNS}, friendships.created_at AS sent_at, friendships.addressee_id = $1 AS incoming
         FROM friendships
         JOIN users ON users.id = CASE WHEN friendships.addressee_id = $1 THEN friendships.requester_id
                                       ELSE friendships.addressee_id END
         WHERE (friendships.requester_id = $1 OR friendships.addressee_id = $1) AND friendships.status = 'pending'
         ORDER BY friendships.created_at DESC, users.handle`,
        [user_id]
    );
    const strip = function ({incoming, ...player}) {
        return player;
    };
    return {
        incoming: rows.filter((row) => row.incoming).map(strip),
        outgoing: rows.filter((row) => !row.incoming).map(strip),
    };
}

// `text` for a LIKE pattern, with its wildcards taken literally.
function like_escape(text) {
    return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * Players (never bots, never the player themself) whose handle starts with `query` or whose name contains it, best
 * matches first: [{handle, name, image, relationship}], where relationship is as relationship() says.
 */
async function search({user_id, query, limit = 10, client = pool}) {
    const pattern = like_escape(query.toLowerCase());
    const {rows} = await client.query(
        `SELECT ${PLAYER_COLUMNS},
                CASE WHEN friendships.status = 'accepted' THEN 'friends'
                     WHEN friendships.requester_id = $1 THEN 'outgoing'
                     WHEN friendships.addressee_id = $1 THEN 'incoming'
                     ELSE 'none' END AS relationship
         FROM users
         LEFT JOIN friendships ON (friendships.requester_id = $1 AND friendships.addressee_id = users.id)
                               OR (friendships.addressee_id = $1 AND friendships.requester_id = users.id)
         WHERE users.id <> $1 AND NOT users.is_bot
           AND (users.handle LIKE $2 || '%' OR lower(users.name) LIKE '%' || $2 || '%')
         ORDER BY users.handle = $4 DESC, users.handle LIKE $2 || '%' DESC, users.handle
         LIMIT $3`,
        [user_id, pattern, limit, query.toLowerCase()]
    );
    return rows;
}

/** `inviter_id` invites `invitee_id` to the table `room_id`; again only renews the invitation. */
async function invite({room_id, inviter_id, invitee_id, client = pool}) {
    await client.query(
        `INSERT INTO table_invitations (room_id, inviter_id, invitee_id) VALUES ($1, $2, $3)
         ON CONFLICT (room_id, invitee_id) DO UPDATE SET inviter_id = $2, created_at = now()`,
        [String(room_id), inviter_id, invitee_id]
    );
}

/**
 * The invitations still worth answering, newest first: tables whose game hasn't started and which the player has no
 * seat at. [{room_id, room_name, from: {handle, name, image}, sent_at, seats_taken, seats}]
 */
async function list_invitations({user_id, client = pool}) {
    const {rows} = await client.query(
        `SELECT rooms.id AS room_id, rooms.name AS room_name, ${PLAYER_COLUMNS}, table_invitations.created_at AS sent_at,
                (SELECT count(*)::INT FROM room_seats WHERE room_seats.room_id = rooms.id) AS seats_taken,
                (rooms.team_count * rooms.players_per_team)::INT AS seats
         FROM table_invitations
         JOIN rooms ON rooms.id = table_invitations.room_id
         JOIN users ON users.id = table_invitations.inviter_id
         WHERE table_invitations.invitee_id = $1
           AND NOT EXISTS (SELECT 1 FROM games WHERE games.room_id = rooms.id)
           AND NOT EXISTS (SELECT 1 FROM room_seats WHERE room_seats.room_id = rooms.id AND room_seats.user_id = $1)
         ORDER BY table_invitations.created_at DESC`,
        [user_id]
    );
    return rows.map(function ({handle, name, image, ...invitation}) {
        return Object.assign(invitation, {from: {handle, name, image}});
    });
}

/** Drops the player's invitation to `room_id` (they dismissed it, or took a seat there). */
async function dismiss_invitation({user_id, room_id, client = pool}) {
    const {rowCount} = await client.query(
        'DELETE FROM table_invitations WHERE room_id = $1 AND invitee_id = $2',
        [String(room_id), user_id]
    );
    return rowCount > 0;
}

module.exports = {
    player, count_outgoing, relationship, request, accept, remove, list_friends, list_requests, search, invite, list_invitations, dismiss_invitation,
};
