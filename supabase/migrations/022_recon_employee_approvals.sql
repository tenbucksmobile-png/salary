-- Employees tab approvals: per-record tickbox state (Basic Salary Mismatch / New
-- Appointment / Termination) for CSL/NL, captured via the tab's own "Submit" button.
-- Purely a staging/audit record for now -- nothing here writes to the employees table.
-- A later "commit" action (admin-only) will read approved=true rows from here and apply
-- them to employees/salary_records. See CLAUDE.md "Reconciliation > Employees tab".

CREATE TABLE recon_employee_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year     int  NOT NULL,
  period_month    int  NOT NULL,
  category        text NOT NULL,   -- basic_mismatch | new_appointment | termination
  employee_name   text NOT NULL,
  employee_code   text,
  detail          jsonb,           -- e.g. {"prevBasic":..,"currBasic":..,"diff":..} or {"basic":..}
  approved        boolean NOT NULL DEFAULT false,
  submitted_at    timestamptz,
  submitted_by    text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year, period_month, category, employee_name)
);

ALTER TABLE recon_employee_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_employee_approvals FOR ALL TO anon USING (true) WITH CHECK (true);
