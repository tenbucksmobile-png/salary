-- Leave Provision: manually-entered "what's currently on the books" figure
-- per hotel/year, compared against the summed leave_provisions.provision_value
-- to compute the year-end adjustment required.

CREATE TABLE leave_provision_book_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year     int NOT NULL,
  book_provision  numeric NOT NULL DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE leave_provision_book_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON leave_provision_book_balances FOR ALL TO anon USING (true) WITH CHECK (true);
