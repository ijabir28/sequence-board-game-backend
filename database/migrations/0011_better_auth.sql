-- Accounts and sessions move to Better Auth (auth.js), which maps its tables onto these names and columns.
-- Existing accounts keep their id, handle, name and password; everyone is signed out once, as the old sessions go.

-- `users` is Better Auth's user table: `handle` is the username plugin's username, `id` stays the BIGINT that
-- rooms, seats and turns reference.
-- Accounts from before had no email. They get a placeholder on the reserved `.invalid` domain (RFC 2606), which no
-- mail can reach, until the player adds a real one; see `PLACEHOLDER_EMAIL_DOMAIN` in entity/user.js.
ALTER TABLE users ADD COLUMN email TEXT;
UPDATE users SET email = handle || '@no-email.invalid';
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
-- Better Auth lower-cases emails before storing or looking them up.
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD COLUMN email_verified BOOLEAN     NOT NULL DEFAULT false;
-- The avatar's URL, or null.
ALTER TABLE users ADD COLUMN image          TEXT;
ALTER TABLE users ADD COLUMN updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

-- How a user signs in. Passwords are the `credential` provider's rows; `password` keeps the scrypt format from
-- entity/user.js, so hashes made before Better Auth still verify.
CREATE TABLE auth_accounts (
    id                       BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id                  BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- The user's id at the provider; for `credential` it is the user's own id.
    account_id               TEXT        NOT NULL,
    provider_id              TEXT        NOT NULL,
    access_token             TEXT,
    refresh_token            TEXT,
    id_token                 TEXT,
    access_token_expires_at  TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope                    TEXT,
    password                 TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_accounts_user_index ON auth_accounts (user_id);

INSERT INTO auth_accounts (user_id, account_id, provider_id, password, created_at)
SELECT id, id::text, 'credential', password_hash, created_at FROM users;
ALTER TABLE users DROP COLUMN password_hash;

-- Signed-in sessions. `token` is the value in the session cookie (which is also signed with the secret).
CREATE TABLE auth_sessions (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token      TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_index ON auth_sessions (user_id);

-- Single-use tokens, such as email verification and password reset.
CREATE TABLE auth_verifications (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identifier TEXT        NOT NULL,
    value      TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_index ON auth_verifications (identifier);

-- express-session's store, replaced by auth_sessions.
DROP TABLE session;
