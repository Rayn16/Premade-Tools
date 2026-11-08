CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tok TEXT NOT NULL UNIQUE,
  approved INTEGER NOT NULL DEFAULT 0, admin INTEGER NOT NULL DEFAULT 0,
  devices TEXT NOT NULL DEFAULT '[]', seen INTEGER NOT NULL DEFAULT 0, made INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, dev TEXT NOT NULL,
  name TEXT NOT NULL, size INTEGER NOT NULL, up TEXT, ready INTEGER NOT NULL DEFAULT 0, made INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_dst ON items(dst, ready);
-- Which PC each paired phone belongs to (by a hash of the phone's key), so a phone finds its PC's link by itself.
CREATE TABLE IF NOT EXISTS phones (h TEXT PRIMARY KEY, pc TEXT NOT NULL, seen INTEGER NOT NULL);
