-- RouteWatch migration 004: public passenger registration, email verification, password recovery, Google sign-in,
-- and idle session expiry. Runs once (migrate.js records it in schema_migrations).
--
-- What changes for EXISTING data: nothing is rewritten. Existing users keep their username, role, password hash, status and
-- assignments; their new email / Google columns are simply empty, so they keep signing in exactly as before.
-- The only relaxed rule: password_hash may now be NULL, for accounts created with Google that never set a password. A new
-- CHECK guarantees every account still has at least one way to sign in (a password or a Google identity).
--
-- Design notes
--  * Email registrations wait in pending_registrations until the code sent to the address is entered. Only then is the
--    users row created (as a passenger), so an unverified address can never own an account, and nobody can block someone
--    else's email address or username by registering it first: an unfinished registration expires after 10 minutes.
--  * Codes are stored as bcrypt hashes (never the code), are single-use, expire after 10 minutes and allow 5 attempts.
--  * A Google account is identified by Google's stable "sub" id, never by its email address, and is never linked to an
--    existing account automatically.
--
-- Recovery (only if this migration must be undone; take a pg_dump first. Fails while any account has no password):
--   DROP TABLE password_reset_codes; DROP TABLE pending_registrations;
--   ALTER TABLE sessions DROP COLUMN last_seen_at;
--   ALTER TABLE users DROP CONSTRAINT users_can_sign_in, DROP CONSTRAINT users_verified_needs_email, DROP CONSTRAINT users_email_format,
--     DROP CONSTRAINT users_google_sub_format, DROP CONSTRAINT users_email_key, DROP CONSTRAINT users_google_sub_key,
--     DROP COLUMN email, DROP COLUMN email_verified_at, DROP COLUMN google_sub, ALTER COLUMN password_hash SET NOT NULL;
--   DELETE FROM schema_migrations WHERE version = 4;

ALTER TABLE users
  ADD COLUMN email             text,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN google_sub        text,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD CONSTRAINT users_email_key UNIQUE (email),
  ADD CONSTRAINT users_google_sub_key UNIQUE (google_sub),
  ADD CONSTRAINT users_email_format CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ADD CONSTRAINT users_google_sub_format CHECK (google_sub IS NULL OR google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  ADD CONSTRAINT users_can_sign_in CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL),
  ADD CONSTRAINT users_verified_needs_email CHECK (email_verified_at IS NULL OR email IS NOT NULL);

-- Idle expiry: a session also ends when it has not been used for SESSION_IDLE_MINUTES (the absolute limit stays expires_at).
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE pending_registrations (
  email              text        PRIMARY KEY CHECK (email = lower(email) AND char_length(email) <= 254),
  username           text        NOT NULL CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  password_hash      text        NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),
  code_hash          text        NOT NULL CHECK (code_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),
  expires_at         timestamptz NOT NULL,
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sends              integer     NOT NULL DEFAULT 1 CHECK (sends >= 1),   -- codes sent in the current one-hour window
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  last_sent_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_registrations_expires_idx ON pending_registrations (expires_at);

CREATE TABLE password_reset_codes (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username     text        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
  code_hash    text        NOT NULL CHECK (code_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_codes_user_idx ON password_reset_codes (username, created_at DESC);
