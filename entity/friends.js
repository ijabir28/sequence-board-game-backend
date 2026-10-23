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

/** The handle a request names (trimmed, lower case, without a leading @), or '' for none. */
function parse_handle(value) {
    return normalize_handle(value).replace(/^@/, '');
}

module.exports = {FriendError, MAX_PENDING_REQUESTS, SEARCH_LIMIT, parse_search, parse_handle};
