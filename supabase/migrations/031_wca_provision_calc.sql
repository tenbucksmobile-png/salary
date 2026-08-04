-- Formalises the "Provision" cascade the company runs periodically on top
-- of the Reconciliation tab's Adjusted Balance (see CLAUDE.md WCA
-- Reconciliation section). Unlike wca_manual_entries' provision_held
-- (a one-off snapshot), this row's Provision Required is recomputed live
-- from the current Adjusted Balance every time it's viewed — only the
-- genuinely manual inputs (accrual not yet invoiced, risk %, and what's
-- actually on the books) are persisted.
--
-- Provision Required = Adjusted Balance + accrual_not_invoiced
--   − penalty_dispute_amount × penalty_risk_pct/100
--   − interest_dispute_amount × interest_risk_pct/100
-- (computed client-side, matches the company's own worksheet exactly)

CREATE TABLE wca_provision_calc (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year             int NOT NULL,
  accrual_not_invoiced    numeric NOT NULL DEFAULT 0,
  penalty_dispute_amount  numeric NOT NULL DEFAULT 0,
  penalty_risk_pct        numeric NOT NULL DEFAULT 50,
  interest_dispute_amount numeric NOT NULL DEFAULT 0,
  interest_risk_pct       numeric NOT NULL DEFAULT 50,
  provision_on_hand       numeric NOT NULL DEFAULT 0,
  updated_at              timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE wca_provision_calc ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON wca_provision_calc FOR ALL TO anon USING (true) WITH CHECK (true);
