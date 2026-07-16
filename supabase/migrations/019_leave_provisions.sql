-- Leave Provision: annual (July) leave balance import + daily-rate provision calc.
-- Standalone/informational — does not feed CTC, total_cost, or calculateBurden().

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS leave_provision_divisor numeric;

CREATE TABLE leave_provisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        uuid REFERENCES employees(id) ON DELETE CASCADE NOT NULL,
  hotel_id           uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year        int NOT NULL,
  leave_balance_days numeric NOT NULL DEFAULT 0,
  daily_rate         numeric NOT NULL DEFAULT 0,
  provision_value    numeric NOT NULL DEFAULT 0,
  basic_at_calc      numeric NOT NULL DEFAULT 0,   -- basic_salary used for the calc, for audit
  import_id          uuid REFERENCES payroll_imports(id),
  imported_at        timestamptz DEFAULT now(),
  UNIQUE(employee_id, period_year)
);

ALTER TABLE leave_provisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON leave_provisions FOR ALL TO anon USING (true) WITH CHECK (true);
