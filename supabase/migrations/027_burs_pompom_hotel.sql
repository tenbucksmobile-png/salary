-- BURS (Botswana PAYE submission) support: a new hotel, Pom Pom, exists only
-- for the BURS page — it must not appear in any other hotel list app-wide.
-- is_burs_only gates that (see sortHotels() in src/lib/utils.ts).

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS is_burs_only boolean NOT NULL DEFAULT false;

INSERT INTO hotels (name, short_code, country, wca_rate, is_burs_only)
VALUES ('Pom Pom', 'PomPom', 'Botswana', 0, true);
