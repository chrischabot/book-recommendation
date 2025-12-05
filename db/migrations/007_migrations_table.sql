-- Track applied migrations
CREATE TABLE IF NOT EXISTS "_migrations" (
  id          SERIAL PRIMARY KEY,
  filename    TEXT UNIQUE NOT NULL,
  applied_at  TIMESTAMP DEFAULT NOW()
);
