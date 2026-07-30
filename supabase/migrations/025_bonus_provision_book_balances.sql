-- Bonus Provision: manually-entered "what's currently on the books" figure
-- per hotel/year, compared against the summed salary_records.bonus_provision
-- (as calculated by Methods' bonus rates) to compute the adjustment required.
-- Same pattern as leave_provision_book_balances (migration 024).

CREATE TABLE bonus_provision_book_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year     int NOT NULL,
  book_provision  numeric NOT NULL DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE bonus_provision_book_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON bonus_provision_book_balances FOR ALL TO anon USING (true) WITH CHECK (true);
