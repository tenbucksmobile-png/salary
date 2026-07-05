-- Per-sub-user configurable tab access (previously hardcoded to
-- Employees + Import + Reconciliation for every sub user).
-- Admin users ignore this column entirely (always full access).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS allowed_tabs text[] DEFAULT ARRAY['employees', 'import', 'reconciliation'];

-- Backfill existing sub users to the tabs they already had access to,
-- so nobody loses access when this ships.
UPDATE users
SET allowed_tabs = ARRAY['employees', 'import', 'reconciliation']
WHERE role = 'sub' AND allowed_tabs IS NULL;
