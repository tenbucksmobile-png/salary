-- Multi-user access control
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'sub' CHECK (role IN ('admin', 'sub')),
  hotel_ids     uuid[],   -- NULL = all hotels (admin); array = restricted subset
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON users FOR ALL TO anon USING (true) WITH CHECK (true);
