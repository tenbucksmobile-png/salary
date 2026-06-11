-- Payroll reconciliation: per-period file upload tracking and cross-check workflow

CREATE TABLE reconciliation_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year   int  NOT NULL,
  period_month  int  NOT NULL,
  status        text NOT NULL DEFAULT 'open',  -- open | submitted | approved
  notes         text,
  created_at    timestamptz DEFAULT now(),
  submitted_at  timestamptz,
  approved_at   timestamptz,
  approved_by   text,
  UNIQUE(hotel_id, period_year, period_month)
);

ALTER TABLE reconciliation_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON reconciliation_periods FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE TABLE recon_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id     uuid REFERENCES reconciliation_periods(id) ON DELETE CASCADE NOT NULL,
  upload_type   text NOT NULL,   -- payroll | afritec | topline | furnmart | cbstores | bodulo | medical
  file_name     text,
  parsed_data   jsonb,
  row_count     int,
  total_amount  numeric,
  uploaded_at   timestamptz DEFAULT now(),
  uploaded_by   text,
  UNIQUE(period_id, upload_type)
);

ALTER TABLE recon_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_uploads FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE TABLE recon_queries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id        uuid REFERENCES reconciliation_periods(id) ON DELETE CASCADE NOT NULL,
  message          text NOT NULL,
  created_at       timestamptz DEFAULT now(),
  author_name      text,
  resolved_at      timestamptz,
  resolver_name    text,
  resolved_message text
);

ALTER TABLE recon_queries ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON recon_queries FOR ALL TO anon USING (true) WITH CHECK (true);
