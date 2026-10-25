-- How often a player dismissed invitations to a table. Each dismissal makes the next invitation to that table wait
-- longer, and after the last allowed one nobody at the table can invite them again (see entity/friends.js).
-- Dismissing deletes the invitation itself (table_invitations), so the count lives here.
CREATE TABLE table_invitation_dismissals (
    room_id           TEXT        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    invitee_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    dismissals        INT         NOT NULL DEFAULT 1 CHECK (dismissals > 0),
    last_dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, invitee_id)
);
