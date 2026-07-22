-- Terminations tracking for the Reconciliation module. Records employees who were
-- present in the DB active roster but absent from a given month's uploaded payroll
-- (candidate terminations), so they can be tracked month by month without ever
-- writing back to the employees table itself. Purely a read/record log — see
-- CLAUDE.md "Reconciliation > Terminations" for the workflow this backs.

CREATE TABLE recon_terminations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  employee_id     uuid REFERENCES employees(id) ON DELETE SET NULL,
  employee_name   text NOT NULL,       -- snapshot at flag time, survives employee deletion
  employee_code   text,
  detected_year   int  NOT NULL,
  detected_month  int  NOT NULL,       -- first period the employee was found missing from payroll
  note            text,
  status          text NOT NULL DEFAULT 'flagged',  -- flagged | confirmed | reinstated
  created_at      timestamptz DEFAULT now(),
  created_by      text,
  resolved_at     timestamptz,
  resolved_by     text,
  resolved_note   text,
  UNIQUE(hotel_id, employee_id, detected_year, detected_month)
);

ALTER TABLE recon_terminations ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_terminations FOR ALL TO anon USING (true) WITH CHECK (true);
