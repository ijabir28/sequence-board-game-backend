-- The host runs their table before its game starts: they can stand a player up, seat anyone at the table in any seat,
-- or send a player away (see controller/room.js).

-- Who is at a table: everyone who has taken a seat there, whether or not they still have one. A player stood up
-- (by themself or the host) stays here, so the host can seat them again; being sent away deletes the row.
CREATE TABLE room_members (
    room_id   TEXT        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id   BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_index ON room_members (user_id);

-- Everyone seated today is at their table.
INSERT INTO room_members (room_id, user_id, joined_at)
SELECT room_id, user_id, joined_at FROM room_seats
ON CONFLICT DO NOTHING;

-- Players the host sent away from a table: they can't sit down there again unless the host invites them back.
CREATE TABLE room_bans (
    room_id    TEXT        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
