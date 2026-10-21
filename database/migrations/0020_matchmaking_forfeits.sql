-- Quick Match forfeits.

-- A player who forfeited a quick match (by choice, or after missing 10 turns in a row). In a two-team match the
-- other team wins at once; in a three-team match a bot plays the rest of the game from this seat. Either way the
-- seat stays theirs in the table's history.
ALTER TABLE room_seats ADD COLUMN forfeited_at TIMESTAMPTZ;

-- The rating a player lost by forfeiting. In a three-team match it is saved when they forfeit, before the round ends,
-- and the round's own rating then leaves them out.
ALTER TABLE matchmaking_results ADD COLUMN forfeit BOOLEAN NOT NULL DEFAULT false;

-- What forfeiting costs: a loss to every other team at the table (each counting a share, as in a round), saved at
-- once. Does nothing for a player already rated in this round.
CREATE FUNCTION record_matchmaking_forfeit(round_id BIGINT, forfeiter BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    K CONSTANT NUMERIC := 32;
    table_id TEXT;
    own_team SMALLINT;
    other_teams INTEGER;
    own_rating INTEGER;
    change INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM matchmaking_results WHERE game_id = round_id AND user_id = forfeiter) THEN
        RETURN;
    END IF;
    SELECT room_id INTO table_id FROM games WHERE id = round_id;
    SELECT team INTO own_team FROM room_seats WHERE room_id = table_id AND user_id = forfeiter;
    SELECT count(DISTINCT team) - 1 INTO other_teams FROM room_seats WHERE room_id = table_id;
    IF own_team IS NULL OR other_teams < 1 THEN
        RETURN;
    END IF;

    -- Only the forfeiter's rating changes, so only they get a row; the others count at 1200 until they have one.
    INSERT INTO matchmaking_ratings (user_id) VALUES (forfeiter) ON CONFLICT (user_id) DO NOTHING;
    SELECT rating INTO own_rating FROM matchmaking_ratings WHERE user_id = forfeiter FOR UPDATE;

    SELECT round(K / other_teams * sum(0 - 1 / (1 + power(10, (other.rating - own_rating)::NUMERIC / 400))))::INTEGER
    INTO change
    FROM (
        SELECT avg(coalesce(matchmaking_ratings.rating, 1200)) AS rating
        FROM room_seats LEFT JOIN matchmaking_ratings ON matchmaking_ratings.user_id = room_seats.user_id
        WHERE room_seats.room_id = table_id AND room_seats.team <> own_team
        GROUP BY room_seats.team
    ) AS other;

    INSERT INTO matchmaking_results (game_id, user_id, team, won, rating_before, rating_change, finished_at, forfeit)
    VALUES (round_id, forfeiter, own_team, false, own_rating, change, now(), true);
    UPDATE matchmaking_ratings
    SET rating = rating + change, played = played + 1, updated_at = now()
    WHERE user_id = forfeiter;
END;
$$;

-- The round's rating, now aware of forfeits. A seat a bot took over after its player forfeited rates nobody when it
-- wins. Otherwise every seat counts towards the Elo (a forfeited one with its player's rating), but only the players
-- not already rated by a forfeit have their rating changed.
CREATE OR REPLACE FUNCTION record_matchmaking_result(round_id BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    K CONSTANT NUMERIC := 32;
    round_row RECORD;
    losing_teams INTEGER;
BEGIN
    SELECT id, room_id, winner_team, finished_at INTO round_row FROM games WHERE id = round_id;
    IF round_row.winner_team IS NULL
        OR EXISTS (SELECT 1 FROM matchmaking_results WHERE game_id = round_id AND NOT forfeit) THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM room_seats
               WHERE room_id = round_row.room_id AND team = round_row.winner_team AND forfeited_at IS NOT NULL) THEN
        RETURN;
    END IF;

    SELECT count(DISTINCT team) - 1 INTO losing_teams FROM room_seats WHERE room_id = round_row.room_id;
    IF losing_teams < 1 THEN
        RETURN;
    END IF;

    INSERT INTO matchmaking_ratings (user_id)
    SELECT user_id FROM room_seats WHERE room_id = round_row.room_id ORDER BY user_id
    ON CONFLICT (user_id) DO NOTHING;
    PERFORM 1 FROM matchmaking_ratings
    WHERE user_id IN (SELECT user_id FROM room_seats WHERE room_id = round_row.room_id)
    ORDER BY user_id FOR UPDATE;

    WITH seats AS (
        SELECT room_seats.user_id, room_seats.team, matchmaking_ratings.rating
        FROM room_seats JOIN matchmaking_ratings ON matchmaking_ratings.user_id = room_seats.user_id
        WHERE room_seats.room_id = round_row.room_id
    ),
    teams AS (
        SELECT team, avg(rating) AS rating FROM seats GROUP BY team
    ),
    winner AS (
        SELECT rating FROM teams WHERE team = round_row.winner_team
    ),
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
        INSERT INTO matchmaking_results (game_id, user_id, team, won, rating_before, rating_change, finished_at)
        SELECT round_id, seats.user_id, seats.team, seats.team = round_row.winner_team, seats.rating,
               team_changes.change, round_row.finished_at
        FROM seats JOIN team_changes ON team_changes.team = seats.team
        WHERE NOT EXISTS (SELECT 1 FROM matchmaking_results AS rated
                          WHERE rated.game_id = round_id AND rated.user_id = seats.user_id)
        RETURNING user_id, won, rating_change
    )
    UPDATE matchmaking_ratings
    SET rating = matchmaking_ratings.rating + results.rating_change,
        played = matchmaking_ratings.played + 1,
        won = matchmaking_ratings.won + results.won::INTEGER,
        updated_at = now()
    FROM results
    WHERE matchmaking_ratings.user_id = results.user_id;
END;
$$;
