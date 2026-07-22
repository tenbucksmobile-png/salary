-- Tracks which recon_employee_approvals rows have actually been committed to
-- employees/salary_records (admin-only, via the Employees tab's Commit button),
-- so a row already applied isn't silently re-applied on a later commit.

ALTER TABLE recon_employee_approvals
  ADD COLUMN committed_at timestamptz,
  ADD COLUMN committed_by text;
