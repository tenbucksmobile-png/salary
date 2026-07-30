-- BURS PAYE submission: stores each month's parsed payroll upload for the two
-- submission groups (ILG's own file, and the CSL/NL/CFEM/PomPom combined
-- file). Mirrors recon_uploads' shape (parsed_data jsonb, not raw file bytes).

CREATE TABLE burs_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_year   int NOT NULL,
  period_month  int NOT NULL,
  upload_group  text NOT NULL CHECK (upload_group IN ('ilg', 'combined')),
  file_name     text,
  parsed_data   jsonb,
  uploaded_at   timestamptz DEFAULT now(),
  UNIQUE(period_year, period_month, upload_group)
);

ALTER TABLE burs_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON burs_uploads FOR ALL TO anon USING (true) WITH CHECK (true);
