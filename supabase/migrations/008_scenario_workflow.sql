-- Three-stage salary review workflow: draft → approved → applied
-- Run via Supabase Dashboard → SQL Editor

ALTER TABLE increase_scenarios
  ADD COLUMN IF NOT EXISTS effective_month integer,
  ADD COLUMN IF NOT EXISTS effective_year  integer,
  ADD COLUMN IF NOT EXISTS applied_at      timestamptz;

-- Existing 'committed' rows already have salary_records — treat them as 'applied'
UPDATE increase_scenarios
  SET status = 'applied'
WHERE status = 'committed';
