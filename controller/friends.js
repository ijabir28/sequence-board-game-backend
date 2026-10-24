const {SERVER_ERROR_MESSAGE} = require('./errors');
const db_friends = require('../database/friends');
const db_room = require('../database/rooms');
const db_game = require('../database/games');
const {transaction} = require('../database/pool');
const {FriendError, MAX_PENDING_REQUESTS, SEARCH_LIMIT, parse_search, parse_handle} = require('../entity/friends');
const online = require('./online');
const presence = require('./presence');
const socket_server = require('../socket');

// Friends: finding players, asking them to be friends, answering, unfriending, and inviting a friend to a table.
// Errors are JSON: {error: CODE, message}. Whoever a change concerns hears `friends_updated` on their own sockets
// (socket.js send_to), and an invited friend hears `table_invitation`; their pages then read GET /friends/list again.

const STATUS_BY_ERROR = {
    NOT_SIGNED_IN: 401,
    NOT_AT_TABLE: 403,
    NOT_FRIENDS: 403,
    PLAYER_NOT_FOUND: 404,
    REQUEST_NOT_FOUND: 404,
    INVITATION_NOT_FOUND: 404,
    ROOM_NOT_FOUND: 404,
    ALREADY_FRIENDS: 409,
    ALREADY_REQUESTED: 409,
    TOO_MANY_PENDING: 409,
    GAME_ALREADY_STARTED: 409,
    ALREADY_SEATED: 409,
    TABLE_FULL: 409,
};

const UNIQUE_VIOLATION = '23505';

function handler(action) {
    return function (req, res) {
        action(req, res).catch(function (e) {
            if (res.headersSent) return console.error(e);
            if (e instanceof FriendError) {
                return res.status(STATUS_BY_ERROR[e.code] || 400).send({error: e.code, message: e.message});
            }
            console.error(e);
            res.status(500).send({error: 'SERVER_ERROR', message: SERVER_ERROR_MESSAGE});
        });
    };
}

async function signed_in(req) {
    const me = await db_friends.player({handle: req.handle});
    if (me === undefined) {
        throw new FriendError('NOT_SIGNED_IN', 'Sign in to see your friends.');
    }
    return me;
}

// The other player a request names, by handle (the body's or the path's). Bots aren't anyone's friends.
async function other_player(me, value) {
    const handle = parse_handle(value);
    const other = handle === '' ? undefined : await db_friends.player({handle});
    if (other === undefined || other.is_bot) {
        throw new FriendError('PLAYER_NOT_FOUND', "We couldn't find a player with that username.");
    }
    if (String(other.id) === String(me.id)) {
        throw new FriendError('CANNOT_FRIEND_SELF', "That's you! Add someone else.");
    }
    return other;
}

function changed(...handles) {
    handles.forEach(function (handle) {
        socket_server.send_to({handle, event: 'friends_updated', data: {}});
    });
}

function public_player({handle, name, image}) {
    return {handle, name, image};
}

// A friend as the list shows them. A seat at an unfinished game alone isn't playing: a player who closed the app
// keeps theirs. They play while their game page is open there, which needs the app open and in view too.
function friend_status({friends_can_watch, games, ...friend}) {
    const status = online.status(friend.handle);
    const at = status === 'online' ? games.find((room_id) => presence.is_present(room_id, friend.handle)) : undefined;
    return Object.assign(friend, {
        online: status === 'online',
        away: status === 'away',
        playing: at !== undefined,
        watch: at !== undefined && friends_can_watch ? at : null,
    });
}

/**
 * GET /friends/list: 200 {friends: [{handle, name, image, since, online, away, playing, watch}], incoming, outgoing,
 * invitations}. `online` says whether the friend has the app open and in view, `away` whether it is open but hidden
 * or was until a moment ago (controller/online.js); `playing` whether they are at
 * a table game in progress right now (controller/presence.js), not merely seated at one they walked away from; `watch`
 * is that game's code while they play there, only when the friend lets friends watch (PUT /user/friends-can-watch),
 * else null; `incoming` and `outgoing` are
 * requests waiting, [{handle, name, image, sent_at}]; `invitations` are tables friends asked the player to, still open.
 */
async function overview(req, res) {
    const me = await signed_in(req);
    const [friends, requests, invitations] = await Promise.all([
        db_friends.list_friends({user_id: me.id}),
        db_friends.list_requests({user_id: me.id}),
        db_friends.list_invitations({user_id: me.id}),
    ]);
    res.send({
        friends: friends.map(friend_status),
        incoming: requests.incoming,
        outgoing: requests.outgoing,
        invitations,
    });
}

/** GET /friends/search?q=…: 200 {players: [{handle, name, image, relationship}]}, at most 10. */
async function search(req, res) {
    const me = await signed_in(req);
    const parsed = parse_search(req.query.q);
    if (parsed.error) {
        throw new FriendError('INVALID_SEARCH', parsed.error);
    }
    res.send({players: await db_friends.search({user_id: me.id, query: parsed.query, limit: SEARCH_LIMIT})});
}

/**
 * POST /friends/requests {handle}: asks that player to be friends. 200 {handle, relationship: 'outgoing'}, or
 * 'friends' when they had already asked the player, which accepts their request instead.
 */
async function send_request(req, res) {
    const me = await signed_in(req);
    const other = await other_player(me, req.body && req.body.handle);
    const relationship = await transaction(async function (client) {
        const now = await db_friends.relationship({user_id: me.id, other_id: other.id, client, lock: true});
        if (now === 'friends') {
            throw new FriendError('ALREADY_FRIENDS', `You and ${other.name} are already friends.`);
        }
        if (now === 'outgoing') {
            throw new FriendError('ALREADY_REQUESTED', `You've already asked ${other.name}. They haven't answered yet.`);
        }
        if (now === 'incoming') {
            await db_friends.accept({requester_id: other.id, addressee_id: me.id, client});
            return 'friends';
        }
        if (await db_friends.count_outgoing({user_id: me.id, client}) >= MAX_PENDING_REQUESTS) {
            throw new FriendError('TOO_MANY_PENDING',
                `You have ${MAX_PENDING_REQUESTS} requests waiting for an answer. Cancel some before sending more.`);
        }
        await db_friends.request({requester_id: me.id, addressee_id: other.id, client});
        return 'outgoing';
    }).catch(function (e) {
        // They asked at the same moment, so the pair's row is theirs: the player can accept it.
        if (e.code === UNIQUE_VIOLATION) {
            throw new FriendError('ALREADY_REQUESTED', `${other.name} just sent you a request. Accept it instead.`);
        }
        throw e;
    });
    res.send({handle: other.handle, relationship});
    changed(me.handle, other.handle);
}

/** POST /friends/requests/:handle/accept: 200 {handle, relationship: 'friends'}. */
async function accept_request(req, res) {
    const me = await signed_in(req);
    const other = await other_player(me, req.params.handle);
    if (!await db_friends.accept({requester_id: other.id, addressee_id: me.id})) {
        throw new FriendError('REQUEST_NOT_FOUND', `${other.name} hasn't asked to be your friend, or took the request back.`);
    }
    res.send({handle: other.handle, relationship: 'friends'});
    changed(me.handle, other.handle);
}

/** DELETE /friends/requests/:handle: declines their request, or takes back the player's own. 204. */
async function delete_request(req, res) {
    const me = await signed_in(req);
    const other = await other_player(me, req.params.handle);
    if (!await db_friends.remove({user_id: me.id, other_id: other.id, status: 'pending'})) {
        throw new FriendError('REQUEST_NOT_FOUND', `There's no request between you and ${other.name}.`);
    }
    res.status(204).send();
    changed(me.handle, other.handle);
}

/** DELETE /friends/:handle: no longer friends (either of them may ask again). 204. */
async function unfriend(req, res) {
    const me = await signed_in(req);
    const other = await other_player(me, req.params.handle);
    if (!await db_friends.remove({user_id: me.id, other_id: other.id, status: 'accepted'})) {
        throw new FriendError('NOT_FRIENDS', `You and ${other.name} aren't friends.`);
    }
    res.status(204).send();
    changed(me.handle, other.handle);
}

/** GET /friends/invitations: 200 {invitations}, as in GET /friends/list. */
async function invitations(req, res) {
    const me = await signed_in(req);
    res.send({invitations: await db_friends.list_invitations({user_id: me.id})});
}

/** DELETE /friends/invitations/:room_id: the player won't come. 204. */
async function dismiss_invitation(req, res) {
    const me = await signed_in(req);
    if (!await db_friends.dismiss_invitation({user_id: me.id, room_id: req.params.room_id})) {
        throw new FriendError('INVITATION_NOT_FOUND', 'That invitation has already gone.');
    }
    res.status(204).send();
    changed(me.handle);
}

/**
 * POST /room/:id/invite {handle}: asks a friend to the table. Anyone with a seat there (or its host) may, before the
 * game starts, while a seat is free. 200 {handle}. The friend hears `table_invitation {room_id, room_name, from}`.
 */
async function invite(req, res) {
    const me = await signed_in(req);
    const friend = await other_player(me, req.body && req.body.handle);
    const {id} = req.params;
    const room = await transaction(async function (client) {
        const room = await db_room.get({id, client, lock: true});
        if (room === undefined) {
            throw new FriendError('ROOM_NOT_FOUND', 'There is no table with that code.');
        }
        if (room.administrator !== me.handle && !db_room.is_seated(room, me.handle)) {
            throw new FriendError('NOT_AT_TABLE', 'Take a seat at this table before inviting friends to it.');
        }
        if (room.matchmaking || await db_game.get({room_id: id, client}) !== undefined) {
            throw new FriendError('GAME_ALREADY_STARTED', "The game has started, so nobody new can sit down.");
        }
        if (await db_friends.relationship({user_id: me.id, other_id: friend.id, client}) !== 'friends') {
            throw new FriendError('NOT_FRIENDS', `Add ${friend.name} as a friend first, then you can invite them.`);
        }
        if (db_room.is_seated(room, friend.handle)) {
            throw new FriendError('ALREADY_SEATED', `${friend.name} already has a seat at this table.`);
        }
        if (db_room.is_full(room)) {
            throw new FriendError('TABLE_FULL', 'Every seat at this table is taken.');
        }
        await db_friends.invite({room_id: room.id, inviter_id: me.id, invitee_id: friend.id, client});
        return room;
    });
    res.send({handle: friend.handle});
    socket_server.send_to({
        handle: friend.handle,
        event: 'table_invitation',
        data: {room_id: room.id, room_name: room.name, from: public_player(me)},
    });
    changed(friend.handle);
}

module.exports = {
    overview: handler(overview),
    search: handler(search),
    send_request: handler(send_request),
    accept_request: handler(accept_request),
    delete_request: handler(delete_request),
    unfriend: handler(unfriend),
    invitations: handler(invitations),
    dismiss_invitation: handler(dismiss_invitation),
    invite: handler(invite),
};
