-- The leaderboard: every player's Elo rating, and what each won round did to it.

-- A player's all-time standing, kept up to date as rounds are won so the all-time board is one indexed read. A row
-- appears with the player's first finished round; everyone starts at 1200.
CREATE TABLE player_ratings (
    user_id    BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    rating     INTEGER     NOT NULL DEFAULT 1200,
    played     INTEGER     NOT NULL DEFAULT 0 CHECK (played >= 0),
    won        INTEGER     NOT NULL DEFAULT 0 CHECK (won BETWEEN 0 AND played),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The all-time order (see database/leaderboard.js).
CREATE INDEX player_ratings_rank_index ON player_ratings (rating DESC, won DESC, user_id);

-- One row per player per won round: whether their team won and how far their rating moved. The weekly and daily
-- boards add these up over their window. Append-only.
CREATE TABLE game_results (
    game_id       BIGINT      NOT NULL REFERENCES games (id),
    user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    team          SMALLINT    NOT NULL,
    won           BOOLEAN     NOT NULL,
    rating_before INTEGER     NOT NULL,
    rating_change INTEGER     NOT NULL,
    finished_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (game_id, user_id)
);
CREATE INDEX game_results_finished_index ON game_results (finished_at);

-- Rates a won round (a row of `games`) for everyone seated at its table, once: a second call does nothing. Called by
-- database/games.js record_move() in the transaction that saves the winning move, and below for rounds won before.
--
-- Team Elo: a team's rating is the average of its players'. The winning team beat each losing team; each losing
-- team lost to the winner. With three teams each of those results counts half, so a round moves a rating about as
-- far as a two-team one. Every player of a team gets the same whole-point change: K * (score - expected).
CREATE FUNCTION record_game_result(round_id BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    K CONSTANT NUMERIC := 32;
    round_row RECORD;
    losing_teams INTEGER;
BEGIN
    SELECT id, room_id, winner_team, finished_at INTO round_row FROM games WHERE id = round_id;
    IF round_row.winner_team IS NULL OR EXISTS (SELECT 1 FROM game_results WHERE game_id = round_id) THEN
        RETURN;
    END IF;

    SELECT count(DISTINCT team) - 1 INTO losing_teams FROM room_seats WHERE room_id = round_row.room_id;
    IF losing_teams < 1 THEN
        RETURN;
    END IF;

    -- Everyone seated gets a rating row, then the rows are locked in one order, so two rounds finishing together
    -- with a player in common wait for each other instead of deadlocking.
    INSERT INTO player_ratings (user_id)
    SELECT user_id FROM room_seats WHERE room_id = round_row.room_id ORDER BY user_id
    ON CONFLICT (user_id) DO NOTHING;
    PERFORM 1 FROM player_ratings
    WHERE user_id IN (SELECT user_id FROM room_seats WHERE room_id = round_row.room_id)
    ORDER BY user_id FOR UPDATE;

    WITH seats AS (
        SELECT room_seats.user_id, room_seats.team, player_ratings.rating
        FROM room_seats JOIN player_ratings ON player_ratings.user_id = room_seats.user_id
        WHERE room_seats.room_id = round_row.room_id
    ),
    teams AS (
        SELECT team, avg(rating) AS rating FROM seats GROUP BY team
    ),
    winner AS (
        SELECT rating FROM teams WHERE team = round_row.winner_team
    ),
    -- The change for each team: the winner's against every losing team, a loser's against the winner.
    team_changes AS (
        SELECT teams.team,
               round(CASE
                   WHEN teams.team = round_row.winner_team THEN
                       K / losing_teams * (SELECT sum(1 - 1 / (1 + power(10, (loser.rating - winner.rating) / 400)))
                                           FROM teams AS loser WHERE loser.team <> round_row.winner_team)
                   ELSE
                       K / losing_teams * (0 - 1 / (1 + power(10, (winner.rating - teams.rating) / 400)))
               END)::INTEGER AS change
        FROM teams CROSS JOIN winner
    ),
    results AS (
        INSERT INTO game_results (game_id, user_id, team, won, rating_before, rating_change, finished_at)
        SELECT round_id, seats.user_id, seats.team, seats.team = round_row.winner_team, seats.rating,
               team_changes.change, round_row.finished_at
        FROM seats JOIN team_changes ON team_changes.team = seats.team
        RETURNING user_id, won, rating_change
    )
    UPDATE player_ratings
    SET rating = player_ratings.rating + results.rating_change,
        played = player_ratings.played + 1,
        won = player_ratings.won + results.won::INTEGER,
        updated_at = now()
    FROM results
    WHERE player_ratings.user_id = results.user_id;
END;
$$;

-- Rounds won before the leaderboard, oldest first, so ratings come out as if they had been kept all along.
DO $$
DECLARE
    round_id BIGINT;
BEGIN
    FOR round_id IN SELECT id FROM games WHERE winner_team IS NOT NULL ORDER BY finished_at, id LOOP
        PERFORM record_game_result(round_id);
    END LOOP;
END;
$$;
