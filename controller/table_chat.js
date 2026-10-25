// The chat and quick reactions at each table, in its lobby and during its game. Everything said at a table is public:
// a message or reaction goes to every socket that has the table open (seated players and spectators alike), and there
// is no way to address one person. There is deliberately no private or direct message, so players can't pass each
// other hints about their hands; nothing here takes a recipient, and anything a client adds to a payload is dropped.
//
// Kept in memory, like presence and spectators: a table keeps its last HISTORY_LENGTH messages, which a page is sent
// when it opens the chat, and after a restart the chat starts empty. Reactions are only shown as they happen.
//
// Anyone with the table's link may read its chat, signed in or not; only a signed-in account may speak, under its own
// name (read from the socket's session cookie, so nobody can speak as someone else).

const MAX_TEXT_LENGTH = 200;
const HISTORY_LENGTH = 50;
// Tables whose chat is kept; the quietest is forgotten first.
const MAX_TABLES = 500;
// A socket can have a few tables open at once (several tabs share one socket), like spectators.js.
const MAX_OPEN_PER_CONNECTION = 5;
// Each account may send this many messages, and separately this many reactions, in any RATE_WINDOW_MS: tapping
// reactions quickly never holds up the next message.
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10000;
const MAX_ROOM_ID_LENGTH = 80;

/** The quick reactions, by id; the client draws each one. */
const REACTIONS = ['wow', 'clap', 'party', 'fire', 'laugh', 'heart', 'love', 'cry', 'angry', 'high_five', 'fist', 'cool'];

const ERRORS = {
    NOT_SIGNED_IN: 'Sign in to chat at this table.',
    NOT_AT_TABLE: 'Open the table to chat there.',
    EMPTY: 'Type a message first.',
    TOO_LONG: `Messages are at most ${MAX_TEXT_LENGTH} characters.`,
    TOO_FAST: 'Slow down a little: you can send more in a few seconds.',
    UNKNOWN_REACTION: "That reaction isn't one of the table's.",
};

const histories = new Map();
const sent = new Map();
let last_id = 0;

function is_room_id(room_id) {
    return typeof room_id === 'string' && room_id.length > 0 && room_id.length <= MAX_ROOM_ID_LENGTH;
}

/** The Socket.IO room of everyone who has the table's chat open. */
function channel(room_id) {
    return `table:${room_id}`;
}

function failure(error) {
    return {error, message: ERRORS[error]};
}

function next_id(now) {
    last_id += 1;
    return `${now.toString(36)}-${last_id.toString(36)}`;
}

/** One line of text: control characters and runs of whitespace become single spaces. */
function clean_text(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Whether `handle` may send one more of `kind` ('message' or 'reaction') now, counting it if so. */
function take_turn(handle, kind, now) {
    const key = `${kind}:${handle}`;
    const times = (sent.get(key) || []).filter(function (at) {
        return now - at < RATE_WINDOW_MS;
    });
    if (times.length >= RATE_LIMIT) {
        sent.set(key, times);
        return false;
    }
    times.push(now);
    sent.set(key, times);
    return true;
}

function remember(room_id, message) {
    const messages = histories.get(room_id) || [];
    // Re-inserted, so the Map stays ordered from the quietest table to the busiest.
    histories.delete(room_id);
    messages.push(message);
    if (messages.length > HISTORY_LENGTH) messages.splice(0, messages.length - HISTORY_LENGTH);
    histories.set(room_id, messages);
    while (histories.size > MAX_TABLES) histories.delete(histories.keys().next().value);
}

/** The table's last messages, oldest first. */
function history(room_id) {
    return (histories.get(room_id) || []).slice();
}

/**
 * `author` ({handle, name}, or undefined when signed out) says `text` at the table. Returns {message} to send to the
 * whole table, or {error, message}.
 */
function post_message({room_id, author, text, now = Date.now()}) {
    if (author === undefined) return failure('NOT_SIGNED_IN');
    if (!is_room_id(room_id)) return failure('NOT_AT_TABLE');
    const clean = clean_text(text);
    if (clean.length === 0) return failure('EMPTY');
    if (clean.length > MAX_TEXT_LENGTH) return failure('TOO_LONG');
    if (!take_turn(author.handle, 'message', now)) return failure('TOO_FAST');
    const message = {id: next_id(now), author: {handle: author.handle, name: author.name}, text: clean, at: new Date(now).toISOString()};
    remember(room_id, message);
    return {message};
}

/** `author` reacts at the table with one of REACTIONS. Returns {reaction} to send to the whole table, or {error, message}. */
function react({room_id, author, reaction, now = Date.now()}) {
    if (author === undefined) return failure('NOT_SIGNED_IN');
    if (!is_room_id(room_id)) return failure('NOT_AT_TABLE');
    if (!REACTIONS.includes(reaction)) return failure('UNKNOWN_REACTION');
    if (!take_turn(author.handle, 'reaction', now)) return failure('TOO_FAST');
    return {reaction: {id: next_id(now), author: {handle: author.handle, name: author.name}, reaction, at: new Date(now).toISOString()}};
}

/**
 * Handles one socket's chat events (see docs/api.md). `io` is the Socket.IO server, `account()` who the socket is
 * ({handle, name}, or undefined), and `room_exists(room_id)` resolves to whether there is such a table.
 */
function bind({connection, io, account, room_exists}) {
    const open = new Set();

    function reply_to(ack) {
        return typeof ack === 'function' ? ack : function () {};
    }

    connection.on('open_table_chat', function (data) {
        const room_id = data && data.room_id;
        if (!is_room_id(room_id) || (!open.has(room_id) && open.size >= MAX_OPEN_PER_CONNECTION)) return;
        room_exists(room_id)
            .then(function (exists) {
                if (!exists || connection.disconnected) return;
                open.add(room_id);
                connection.join(channel(room_id));
                connection.emit('table_chat_history', {room_id, messages: history(room_id)});
            })
            .catch(function (e) {
                console.error(e);
            });
    });

    connection.on('close_table_chat', function (data) {
        const room_id = data && data.room_id;
        if (!open.has(room_id)) return;
        open.delete(room_id);
        connection.leave(channel(room_id));
    });

    // Only the room and the text (or reaction) are read from the payload: whatever else it carries, the message goes
    // to the whole table.
    connection.on('send_table_chat', function (data, ack) {
        const room_id = data && data.room_id;
        if (!open.has(room_id)) return reply_to(ack)(failure('NOT_AT_TABLE'));
        const result = post_message({room_id, author: account(), text: data.text});
        if (result.error) return reply_to(ack)(result);
        io.to(channel(room_id)).emit('table_chat', {room_id, message: result.message});
        reply_to(ack)({ok: true});
    });

    connection.on('send_table_reaction', function (data, ack) {
        const room_id = data && data.room_id;
        if (!open.has(room_id)) return reply_to(ack)(failure('NOT_AT_TABLE'));
        const result = react({room_id, author: account(), reaction: data.reaction});
        if (result.error) return reply_to(ack)(result);
        io.to(channel(room_id)).emit('table_reaction', {room_id, reaction: result.reaction});
        reply_to(ack)({ok: true});
    });
}

/** Forgets a table's chat (the table was deleted). */
function forget(room_id) {
    histories.delete(String(room_id));
}

/** Forgets every table's chat and every rate limit (for tests). */
function reset() {
    histories.clear();
    sent.clear();
}

module.exports = {
    MAX_TEXT_LENGTH,
    HISTORY_LENGTH,
    MAX_TABLES,
    MAX_OPEN_PER_CONNECTION,
    RATE_LIMIT,
    RATE_WINDOW_MS,
    REACTIONS,
    channel,
    clean_text,
    history,
    post_message,
    react,
    bind,
    forget,
    reset,
};
