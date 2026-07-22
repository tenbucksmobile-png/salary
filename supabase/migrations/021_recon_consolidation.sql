-- Director-facing monthly bank release sign-off. One row per (period, hotel, line item):
-- system_amount is a manual override, only used where no automatic source exists in this
-- app (CFEM's Basic Salary — CFEM's payroll is never uploaded here); everywhere else the
-- system figure is computed live from the parsed payroll/statement uploads and this column
-- stays null. bank_amount is always a manual entry reflecting what was actually paid to
-- the bank. See CLAUDE.md "Reconciliation > Consolidation" for the full workflow.

CREATE TABLE recon_consolidation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_year       int  NOT NULL,
  period_month      int  NOT NULL,
  hotel_short_code  text NOT NULL,   -- CSL | NL | CFEM
  line_item         text NOT NULL,   -- basic_salary | furnmart | afritec | topline | cbstores | bodulo
  system_amount     numeric,
  bank_amount       numeric,
  updated_at        timestamptz DEFAULT now(),
  updated_by        text,
  UNIQUE(period_year, period_month, hotel_short_code, line_item)
);

ALTER TABLE recon_consolidation ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_consolidation FOR ALL TO anon USING (true) WITH CHECK (true);
