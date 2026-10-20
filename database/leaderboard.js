const {pool} = require('./pool');

// The leaderboard's reads. Ratings are written by record_game_result() (migration 0017) as rounds are won.
//
// `all` ranks every rated player by their Elo rating (player_ratings). `week` and `day` rank the players who
// finished a round in the last 7 days / 24 hours by the rating they gained there (game_results), so a short board
// rewards recent form rather than an old lead. Ties share a rank; the order within one is by wins, then by who got
// there first (the lower user id), so pages never overlap.

const PERIODS = {
    all: null,
    week: '7 days',
    day: '24 hours',
};

// One row per ranked player: user_id, score (what the board ranks by), rating, rating_change, played, won.
function standings_sql(period) {
    if (PERIODS[period] === null) {
        return `SELECT user_id, rating AS score, rating, rating - 1200 AS rating_change, played, won
                FROM player_ratings`;
    }
    return `SELECT game_results.user_id, sum(game_results.rating_change)::INTEGER AS score,
                   player_ratings.rating, sum(game_results.rating_change)::INTEGER AS rating_change,
                   count(*)::INTEGER AS played, count(*) FILTER (WHERE game_results.won)::INTEGER AS won
            FROM game_results JOIN player_ratings ON player_ratings.user_id = game_results.user_id
            WHERE game_results.finished_at >= now() - interval '${PERIODS[period]}'
            GROUP BY game_results.user_id, player_ratings.rating`;
}

// The standings with each player's rank (shared by ties) and position (1, 2, 3… in board order).
function ranked_sql(period) {
    return `WITH standings AS (${standings_sql(period)})
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

/** One page of the board, best first: {players: [entry], total}. */
async function list({period, limit, offset, client = pool}) {
    const {rows} = await client.query(
        `SELECT ranked.*, count(*) OVER ()::INTEGER AS total
         FROM (${ranked_sql(period)}) AS ranked
         ORDER BY position LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    let total = rows.length === 0 ? 0 : rows[0].total;
    // A page past the end has no rows to carry the total.
    if (rows.length === 0 && offset > 0) {
        total = (await client.query(`SELECT count(*)::INTEGER AS total FROM (${standings_sql(period)}) AS standings`)).rows[0].total;
    }
    return {players: rows.map(to_entry), total};
}

/** The player's own entry on the board, or undefined when they aren't on it (no round finished in the period). */
async function entry_for({period, user_id, client = pool}) {
    const {rows} = await client.query(`SELECT * FROM (${ranked_sql(period)}) AS ranked WHERE user_id = $1`, [user_id]);
    return rows[0] === undefined ? undefined : to_entry(rows[0]);
}

module.exports = {PERIODS, list, entry_for};
