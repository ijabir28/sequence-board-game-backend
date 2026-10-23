-- Friends: requests between players, and invitations to a table sent to a friend.

-- One row per pair of players, whichever of them asked: `pending` until the other accepts. Declining a request,
-- cancelling it or ending a friendship deletes the row, so either of them may ask again later.
CREATE TABLE friendships (
    requester_id BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    addressee_id BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at  TIMESTAMPTZ,
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id),
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
-- A pair has one row, so two players asking each other at once can't both get theirs in.
CREATE UNIQUE INDEX friendships_pair_key ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
-- Requests waiting for a player, and their friends from the other side.
CREATE INDEX friendships_addressee_index ON friendships (addressee_id);

-- Accepted friendships seen from each side: one row per player per friend. The friends leaderboard
-- (database/leaderboard.js) and the friends list read this.
CREATE VIEW friend_links AS
    SELECT requester_id AS user_id, addressee_id AS friend_id, accepted_at FROM friendships WHERE status = 'accepted'
    UNION ALL
    SELECT addressee_id AS user_id, requester_id AS friend_id, accepted_at FROM friendships WHERE status = 'accepted';

-- A player asked a friend to their table. Answered by taking a seat there or dismissing it; a second invitation to the
-- same table only refreshes the first. The table going away takes its invitations with it.
CREATE TABLE table_invitations (
    room_id    TEXT        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    invitee_id BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    inviter_id BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, invitee_id)
);
CREATE INDEX table_invitations_invitee_index ON table_invitations (invitee_id, created_at DESC);
