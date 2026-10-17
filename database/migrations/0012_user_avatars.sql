-- Profile pictures, kept in the database next to the account so they need no file storage. The frontend shrinks
-- them to a small square before uploading (entity/avatar.js caps the size), so they stay a few kilobytes each.
-- users.image holds the URL that serves the current one (GET /user/avatar/:id?v=…), or null.
CREATE TABLE user_avatars (
    user_id      BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    content_type TEXT        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    data         BYTEA       NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
