CREATE TABLE IF NOT EXISTS card_stars (
  card_id text NOT NULL REFERENCES cards (id),
  user_id text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (card_id, user_id)
);
