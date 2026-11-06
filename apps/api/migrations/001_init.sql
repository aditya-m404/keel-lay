CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id text PRIMARY KEY,
  name text NOT NULL,
  revision bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES boards (id),
  title text NOT NULL,
  "column" text NOT NULL CHECK ("column" IN ('todo', 'doing', 'done')),
  position integer NOT NULL,
  author_id text NOT NULL REFERENCES users (id),
  version bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY,
  card_id text NOT NULL REFERENCES cards (id),
  body text NOT NULL,
  author_id text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  version bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text NOT NULL,
  user_id text NOT NULL REFERENCES users (id),
  request_hash text NOT NULL,
  status integer NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (key, user_id)
);
