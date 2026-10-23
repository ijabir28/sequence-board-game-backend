-- Whether the player's friends may watch their table games from the friends list. Off until the player turns it on
-- in their profile; while off, the friends list says only that they are playing, never where.
ALTER TABLE users ADD COLUMN friends_can_watch BOOLEAN NOT NULL DEFAULT false;
