-- Blitz: a chess-style clock. Each team has this many seconds for the whole round, spent only on its own turns; null
-- (the default) keeps the per-turn timer (turn_seconds). See entity/room.js and controller/room_game.js.
ALTER TABLE rooms ADD COLUMN clock_seconds SMALLINT CHECK (clock_seconds BETWEEN 60 AND 3600);
