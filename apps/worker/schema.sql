CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  pending_login_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  mp_name TEXT NOT NULL,
  mp_cover TEXT NOT NULL,
  mp_intro TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  sync_time INTEGER NOT NULL DEFAULT 0,
  update_time INTEGER NOT NULL,
  has_history INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  mp_id TEXT NOT NULL,
  title TEXT NOT NULL,
  pic_url TEXT NOT NULL DEFAULT "",
  publish_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_mp_id_publish_time
  ON articles (mp_id, publish_time DESC);

CREATE INDEX IF NOT EXISTS idx_feeds_status ON feeds (status);
