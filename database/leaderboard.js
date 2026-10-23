const {pool} = require('./pool');

// The leaderboards' reads. Ratings are written as rounds are won: a private table's by record_game_result()
// (migration 0017) into player_ratings / game_results, a matchmaking table's by record_matchmaking_result() (0018) into
// matchmaking_ratings / matchmaking_results. Each `ladder` reads only its own tables, so the two boards are separate.
// Bots are rated (so beating one counts) but never listed.
//
// `all` ranks every rated player by their Elo rating (player_ratings). `week` and `day` rank the players who
// finished a round in the last 7 days / 24 hours by the rating they gained there (game_results), so a short board
// rewards recent form rather than an old lead. Ties share a rank; the order within one is by wins, then by who got
// there first (the lower user id), so pages never overlap.
//
// A board is either everyone's (`friends_of` left out: the global board, see controller/user.js) or one player's
// circle: `friends_of` is their user id, and the board ranks only them and their friends (migration 0022's
// friend_links), with ranks counted among those players alone.

const PERIODS = {
    all: null,
    week: '7 days',
    day: '24 hours',
};

// Each board's tables: `custom` for private tables, `matchmaking` for Quick Match.
const LADDERS = {
    custom: {ratings: 'player_ratings', results: 'game_results'},
    matchmaking: {ratings: 'matchmaking_ratings', results: 'matchmaking_results'},
};

const NOT_A_BOT = 'user_id NOT IN (SELECT id FROM users WHERE is_bot)';

// The condition that keeps `column` (a user id) to a player's circle, `param` being the placeholder of their user id;
// or none.
function circle_sql(column, param) {
    if (param === undefined) return 'TRUE';
    return `${column} IN (SELECT ${param}::BIGINT UNION SELECT friend_id FROM friend_links WHERE user_id = ${param}::BIGINT)`;
}

// One row per ranked player: user_id, score (what the board ranks by), rating, rating_change, played, won.
// `circle` is the placeholder of the user id whose circle the board is limited to, or undefined for everyone.
function standings_sql(period, ladder = 'custom', circle = undefined) {
    const {ratings, results} = LADDERS[ladder];
    if (PERIODS[period] === null) {
        return `SELECT user_id, rating AS score, rating, rating - 1200 AS rating_change, played, won
                FROM ${ratings} WHERE ${NOT_A_BOT} AND ${circle_sql('user_id', circle)}`;
    }
    return `SELECT ${results}.user_id, sum(${results}.rating_change)::INTEGER AS score,
                   ${ratings}.rating, sum(${results}.rating_change)::INTEGER AS rating_change,
                   count(*)::INTEGER AS played, count(*) FILTER (WHERE ${results}.won)::INTEGER AS won
            FROM ${results} JOIN ${ratings} ON ${ratings}.user_id = ${results}.user_id
            WHERE ${results}.finished_at >= now() - interval '${PERIODS[period]}' AND ${results}.${NOT_A_BOT}
              AND ${circle_sql(`${results}.user_id`, circle)}
            GROUP BY ${results}.user_id, ${ratings}.rating`;
}

// The standings with each player's rank (shared by ties) and position (1, 2, 3… in board order).
function ranked_sql(period, ladder, circle) {
    return `WITH standings AS (${standings_sql(period, ladder, circle)})
            SELECT standings.*,
                   rank() OVER (ORDER BY score DESC)::INTEGER AS rank,
                   row_number() OVER (ORDER BY score DESC, won DESC, user_id)::INTEGER AS position,
                   users.handle, users.name, users.image
            FROM standings JOIN users ON users.id = standings.user_id`;
}

function to_entry(row) {
    return {
        rank: row.rank,
        position: row.position,
        handle: row.handle,
        name: row.name,
        image: row.image,
        score: row.score,
        rating: row.rating,
        rating_change: row.rating_change,
        played: row.played,
        won: row.won,
        lost: row.played - row.won,
        win_rate: row.played === 0 ? 0 : Math.round((row.won / row.played) * 1000) / 1000,
    };
}

/** One page of the board, best first: {players: [entry], total}. `friends_of` limits it to that player's circle. */
async function list({period, ladder = 'custom', friends_of, limit, offset, client = pool}) {
    const circle = friends_of === undefined ? [] : [friends_of];
    const {rows} = await client.query(
        `SELECT ranked.*, count(*) OVER ()::INTEGER AS total
         FROM (${ranked_sql(period, ladder, circle.length ? '$3' : undefined)}) AS ranked
         ORDER BY position LIMIT $1 OFFSET $2`,
        [limit, offset].concat(circle)
    );
    let total = rows.length === 0 ? 0 : rows[0].total;
    // A page past the end has no rows to carry the total.
    if (rows.length === 0 && offset > 0) {
        total = (await client.query(
            `SELECT count(*)::INTEGER AS total FROM (${standings_sql(period, ladder, circle.length ? '$1' : undefined)}) AS standings`,
            circle
        )).rows[0].total;
    }
    return {players: rows.map(to_entry), total};
}

/**
 * The player's own entry on the board, or undefined when they aren't on it (no round finished in the period).
 * `friends_of`, as for list(), ranks them within that circle.
 */
async function entry_for({period, ladder = 'custom', user_id, friends_of, client = pool}) {
    const circle = friends_of === undefined ? [] : [friends_of];
    const {rows} = await client.query(
        `SELECT * FROM (${ranked_sql(period, ladder, circle.length ? '$2' : undefined)}) AS ranked WHERE user_id = $1`,
        [user_id].concat(circle)
    );
    return rows[0] === undefined ? undefined : to_entry(rows[0]);
}

module.exports = {PERIODS, LADDERS, list, entry_for};
