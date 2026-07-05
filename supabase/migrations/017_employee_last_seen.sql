-- Tracks the last time an employee was matched (or added) by a full-roster
-- import — CSL Payroll Schedule or HR List (Employee Details) — so the
-- Employees page can flag anyone who dropped off the most recent roster
-- upload as likely no longer employed. Deliberately NOT touched by manual
-- edits, Calculate Burden, or VIP/Medical Aid imports, so it only reflects
-- "was this person actually on the roster file last time".
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
