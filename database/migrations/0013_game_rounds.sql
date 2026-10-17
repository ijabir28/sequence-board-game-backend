-- A table plays its game in rounds: once a round is won, the host deals another with the same teams, or ends the
-- rounds there. Each round is its own row in `games`, numbered from 1; the highest number is the table's current
-- game. Rooms from before rounds have one game, which becomes their round 1.
ALTER TABLE games DROP CONSTRAINT games_room_id_key;
ALTER TABLE games ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0);
ALTER TABLE games ADD CONSTRAINT games_room_round_key UNIQUE (room_id, round);

-- The round's statistics (entity/rounds.js round_stats()), saved when it is won, so a summary of every round never
-- needs their full states. Null while the round is played, and for rounds won before statistics were kept.
ALTER TABLE games ADD COLUMN stats JSONB;

-- When the host ended the rounds: the table's final result is in, and no further round can be dealt.
ALTER TABLE rooms ADD COLUMN rounds_ended_at TIMESTAMPTZ;
