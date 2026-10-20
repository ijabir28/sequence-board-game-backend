-- Matchmaking: tables the server sets up for players from the Quick Match queue, the bots that fill a seat when no
-- one else is waiting, and a leaderboard of their own, kept apart from the one private tables feed.

-- Bots are accounts, so they can sit at a table, make moves and be rated like anyone. They have no password (no
-- auth_accounts row), so nobody can sign in as one, and their `@bots.invalid` emails are never sent anything
-- (see real_email() in entity/user.js). Their handles start with `bot-`: players' handles can't hold a
-- hyphen, so a bot's handle is never one somebody could sign up with.
ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT users_handle_check;
ALTER TABLE users ADD CONSTRAINT users_handle_check
    CHECK (handle ~ '^[a-z0-9_]{3,20}$' OR (is_bot AND handle ~ '^bot-[a-z]{2,16}$'));

INSERT INTO users (handle, name, email, email_verified, is_bot)
VALUES ('bot-ada', 'Ada Bot', 'bot-ada@bots.invalid', true, true),
       ('bot-alan', 'Alan Bot', 'bot-alan@bots.invalid', true, true),
       ('bot-grace', 'Grace Bot', 'bot-grace@bots.invalid', true, true),
       ('bot-hedy', 'Hedy Bot', 'bot-hedy@bots.invalid', true, true);

-- A table made by matchmaking: one player per team, dealt as soon as it is made, a single round.
ALTER TABLE rooms ADD COLUMN matchmaking BOOLEAN NOT NULL DEFAULT false;

-- The matchmaking leaderboard: the same Elo as player_ratings / game_results (0017), over matchmaking rounds only.
CREATE TABLE matchmaking_ratings (
    user_id    BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    rating     INTEGER     NOT NULL DEFAULT 1200,
    played     INTEGER     NOT NULL DEFAULT 0 CHECK (played >= 0),
    won        INTEGER     NOT NULL DEFAULT 0 CHECK (won BETWEEN 0 AND played),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX matchmaking_ratings_rank_index ON matchmaking_ratings (rating DESC, won DESC, user_id);

CREATE TABLE matchmaking_results (
    game_id       BIGINT      NOT NULL REFERENCES games (id),
    user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    team          SMALLINT    NOT NULL,
    won           BOOLEAN     NOT NULL,
    rating_before INTEGER     NOT NULL,
    rating_change INTEGER     NOT NULL,
    finished_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (game_id, user_id)
);
CREATE INDEX matchmaking_results_finished_index ON matchmaking_results (finished_at);

-- record_game_result() (0017) over the matchmaking tables: rates a won matchmaking round for everyone at its table,
-- bots included (they are left off the board when it is read), once.
CREATE FUNCTION record_matchmaking_result(round_id BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    K CONSTANT NUMERIC := 32;
    round_row RECORD;
    losing_teams INTEGER;
BEGIN
    SELECT id, room_id, winner_team, finished_at INTO round_row FROM games WHERE id = round_id;
    IF round_row.winner_team IS NULL OR EXISTS (SELECT 1 FROM matchmaking_results WHERE game_id = round_id) THEN
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

-- How database/games.js rates every won round: a private table's on the leaderboard 0017 made, a matchmaking one's on
-- the matchmaking leaderboard, so neither ever moves the other's ratings.
CREATE FUNCTION rate_round(round_id BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT rooms.matchmaking FROM games JOIN rooms ON rooms.id = games.room_id WHERE games.id = round_id) THEN
        PERFORM record_matchmaking_result(round_id);
    ELSE
        PERFORM record_game_result(round_id);
    END IF;
END;
$$;
