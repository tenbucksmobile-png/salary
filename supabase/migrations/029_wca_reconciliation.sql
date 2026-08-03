-- WCA reconciliation (IH first — ILRB and APA get their own separate
-- reconciliations later, same schema, filtered by hotel_id).
--
-- Consolidated per-year entry (not a line-by-line ledger — one row per
-- hotel per year carries the year's totals for each category from the
-- Compensation Fund statement of account):
--   opening_balance      — first year only, brought forward
--   provisional_invoice  — estimate submitted for the year ahead
--   reversal             — cancels the provisional once actual is submitted
--   actual_invoice       — raised against actual payroll × Tourism ROE %
--   penalty              — ~10%-of-invoice late-submission penalty
--   interest             — interest accrued on outstanding balance
--   payment              — paid to the Fund that year
--   dispute_credit       — credits passed due to disputes raised
--   other                — anything not covered above
-- Closing balance for a year = prior year's closing + opening_balance +
-- provisional_invoice + actual_invoice + penalty + interest + other
-- − reversal − payment − dispute_credit (computed client-side, not stored).
--
-- wca_manual_entries carries the company's own reconciling records — what
-- the Fund's statement doesn't yet reflect: a payment made but not posted,
-- a dispute raised, or a free-text discrepancy note.
--
-- wca_roe_rates carries the per-hotel, per-year Tourism ROE % used to
-- independently check a given year's Actual Invoice (payroll × rate%).

CREATE TABLE wca_annual_consolidation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year          int NOT NULL,
  opening_balance      numeric NOT NULL DEFAULT 0,
  provisional_invoice  numeric NOT NULL DEFAULT 0,
  reversal             numeric NOT NULL DEFAULT 0,
  actual_invoice       numeric NOT NULL DEFAULT 0,
  penalty              numeric NOT NULL DEFAULT 0,
  interest             numeric NOT NULL DEFAULT 0,
  payment              numeric NOT NULL DEFAULT 0,
  dispute_credit       numeric NOT NULL DEFAULT 0,
  other                numeric NOT NULL DEFAULT 0,
  notes                text,
  updated_at           timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE wca_annual_consolidation ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON wca_annual_consolidation FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE TABLE wca_manual_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  entry_date   date NOT NULL,
  period_year  int,
  entry_type   text NOT NULL CHECK (entry_type IN (
                 'payment_not_reflected', 'dispute_raised', 'discrepancy_note'
               )),
  amount       numeric NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  description  text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX wca_manual_entries_hotel_idx ON wca_manual_entries(hotel_id);

ALTER TABLE wca_manual_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON wca_manual_entries FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE TABLE wca_roe_rates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year  int NOT NULL,
  rate_pct     numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE wca_roe_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON wca_roe_rates FOR ALL TO anon USING (true) WITH CHECK (true);
