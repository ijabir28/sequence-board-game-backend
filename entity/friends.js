const {normalize_handle} = require('./user');

// Friends: the rules that don't need the database. See controller/friends.js for the endpoints.

class FriendError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FriendError';
        this.code = code;
    }
}

// A player can have this many requests waiting on others at once, so nobody can ask everyone.
const MAX_PENDING_REQUESTS = 50;

const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 50;
const SEARCH_LIMIT = 10;

/** {query} trimmed, or {error} saying what a search needs. */
function parse_search(value) {
    const query = typeof value === 'string' ? value.trim() : '';
    if (query.length < SEARCH_MIN_LENGTH) {
        return {error: `Type at least ${SEARCH_MIN_LENGTH} letters of a name or username.`};
    }
    return {query: query.slice(0, SEARCH_MAX_LENGTH)};
}

// After a player dismisses an invitation to a table, the next one to that table waits this many seconds: the first
// entry after their first dismissal, the second after their second, and so on (10 seconds, 30 seconds, 1, 3 and 5
// minutes). Once they have dismissed one more invitation than there are entries (the first plus every re-invite),
// nobody can invite them to that table again.
const REINVITE_COOLDOWN_SECONDS = [10, 30, 60, 180, 300];
const MAX_REINVITES = REINVITE_COOLDOWN_SECONDS.length;

/**
 * Whether a player who dismissed `dismissals` invitations to a table, the last at `last_dismissed_at`, may be invited
 * there again at `now` (ms): {allowed: true}, {allowed: false, limit_reached: true}, or {allowed: false, retry_at: Date}.
 * No dismissals means no wait.
 */
function reinvite_wait({dismissals = 0, last_dismissed_at = null, now = Date.now()} = {}) {
    if (dismissals <= 0) {
        return {allowed: true};
    }
    if (dismissals > MAX_REINVITES) {
        return {allowed: false, limit_reached: true};
    }
    const retry_at = new Date(new Date(last_dismissed_at).getTime() + REINVITE_COOLDOWN_SECONDS[dismissals - 1] * 1000);
    return retry_at.getTime() <= now ? {allowed: true} : {allowed: false, retry_at};
}

/** "10 seconds", "3 minutes", "1 hour 20 minutes": how long until `retry_at`, rounded up to the second under a minute and to the minute after. */
function wait_text(retry_at, now = Date.now()) {
    const part = function (count, unit) {
        return `${count} ${unit}${count === 1 ? '' : 's'}`;
    };
    const seconds = Math.max(1, Math.ceil((new Date(retry_at).getTime() - now) / 1000));
    if (seconds < 60) return part(seconds, 'second');
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return part(minutes, 'minute');
    return rest === 0 ? part(hours, 'hour') : `${part(hours, 'hour')} ${part(rest, 'minute')}`;
}

/** The handle a request names (trimmed, lower case, without a leading @), or '' for none. */
function parse_handle(value) {
    return normalize_handle(value).replace(/^@/, '');
}

module.exports = {
    FriendError, MAX_PENDING_REQUESTS, SEARCH_LIMIT, parse_search, parse_handle,
    REINVITE_COOLDOWN_SECONDS, MAX_REINVITES, reinvite_wait, wait_text,
};
