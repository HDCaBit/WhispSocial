DROP TABLE IF EXISTS posts;
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_token TEXT NOT NULL,
  up_count INTEGER DEFAULT 0,
  down_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  reply_to TEXT
);
