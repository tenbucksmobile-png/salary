-- Manual correction of a PRIOR period's Basic Salary figure in the Employees tab's
-- Basic Salary Mismatch comparison (CSL/NL only). Lets a data-entry error already
-- uploaded for a prior month be fixed inline without re-uploading/re-processing that
-- whole period. Deliberately never applies to the CURRENT period -- the current month's
-- basic salary must come from a real payroll upload; overriding it here would risk
-- masking a genuine payroll change instead of correcting a genuine data error.
CREATE TABLE recon_basic_salary_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year     int  NOT NULL,
  period_month    int  NOT NULL,
  employee_name   text NOT NULL,
  basic_salary    numeric NOT NULL,
  updated_at      timestamptz DEFAULT now(),
  updated_by      text,
  UNIQUE(hotel_id, period_year, period_month, employee_name)
);

ALTER TABLE recon_basic_salary_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_basic_salary_overrides FOR ALL TO anon USING (true) WITH CHECK (true);
