-- Kindle integration: ownership, completion, and reading-intensity signals
-- Adds storage for Kindle export ingestion and downstream aggregates

CREATE TABLE IF NOT EXISTS "KindleOwnership" (
  user_id         TEXT NOT NULL,
  asin            TEXT NOT NULL,
  product_name    TEXT,
  origin_type     TEXT,        -- Purchase | KindleUnlimited | Sample | PDocs | KindleDictionary | etc.
  right_type      TEXT,        -- Download | Lending
  right_status    TEXT,        -- Active | Revoked
  resource_type   TEXT,        -- KindleEBook | KindleEBookSample | KindlePDoc
  acquired_at     TIMESTAMP,
  last_updated_at TIMESTAMP,
  order_id        TEXT,
  transaction_id  TEXT,
  raw             JSONB,
  created_at      TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, asin, right_type)
);

CREATE INDEX IF NOT EXISTS kindle_ownership_user_idx ON "KindleOwnership"(user_id);
CREATE INDEX IF NOT EXISTS kindle_ownership_asin_idx ON "KindleOwnership"(asin);

CREATE TABLE IF NOT EXISTS "UserCompletionEvent" (
  user_id      TEXT NOT NULL,
  asin         TEXT NOT NULL,
  completed_at TIMESTAMP NOT NULL,
  method       TEXT NOT NULL, -- auto_mark | insights_auto | insights_manual | whispersync_last_read
  source_file  TEXT,
  created_at   TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, asin, method, completed_at),
  CHECK (method IN ('auto_mark', 'insights_auto', 'insights_manual', 'whispersync_last_read'))
);

CREATE INDEX IF NOT EXISTS user_completion_user_asin_idx ON "UserCompletionEvent"(user_id, asin);
CREATE INDEX IF NOT EXISTS user_completion_completed_idx ON "UserCompletionEvent"(completed_at DESC);

CREATE TABLE IF NOT EXISTS "UserReadingSession" (
  user_id      TEXT NOT NULL,
  asin         TEXT NOT NULL,
  start_at     TIMESTAMP NOT NULL,
  end_at       TIMESTAMP,
  duration_ms  BIGINT,
  source       TEXT NOT NULL, -- ri_adjusted | ereader_active | legacy_session
  device_family TEXT,
  created_at   TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, asin, start_at, source),
  CHECK (source IN ('ri_adjusted', 'ereader_active', 'legacy_session'))
);

CREATE INDEX IF NOT EXISTS user_reading_session_user_asin_idx ON "UserReadingSession"(user_id, asin);
CREATE INDEX IF NOT EXISTS user_reading_session_start_idx ON "UserReadingSession"(start_at DESC);

-- Day-level reading activity (streak computation)
CREATE TABLE IF NOT EXISTS "UserReadingDay" (
  user_id    TEXT NOT NULL,
  day        DATE NOT NULL,
  source     TEXT NOT NULL, -- ri_day_units
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, day, source),
  CHECK (source IN ('ri_day_units'))
);

CREATE INDEX IF NOT EXISTS user_reading_day_user_idx ON "UserReadingDay"(user_id, day);

-- Aggregated reading metrics per user + ASIN
CREATE TABLE IF NOT EXISTS "UserReadingAggregate" (
  user_id        TEXT NOT NULL,
  asin           TEXT NOT NULL,
  total_ms       BIGINT DEFAULT 0,
  sessions       INT DEFAULT 0,
  last_read_at   TIMESTAMP,
  avg_session_ms NUMERIC(12,2),
  max_session_ms BIGINT,
  streak_days    INT DEFAULT 0,
  last_30d_ms    BIGINT DEFAULT 0,
  updated_at     TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, asin)
);

CREATE INDEX IF NOT EXISTS user_reading_agg_user_idx ON "UserReadingAggregate"(user_id, asin);
CREATE INDEX IF NOT EXISTS user_reading_agg_last_idx ON "UserReadingAggregate"(user_id, last_read_at DESC);
