-- Migration 002 — Add missing payroll burden & provision columns
-- Run in Supabase Dashboard → SQL Editor

-- ─── Employees: HR notes & flags ─────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS comments          text,
  ADD COLUMN IF NOT EXISTS nmw_applicable   boolean DEFAULT false;

-- ─── Salary records: full payroll burden & provisions ─────────────────────────
-- Increase scenario fields
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS increase_amount  numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment       numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS increase_pct     numeric(8,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_basic        numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_ctc          numeric(12,2) DEFAULT 0;

-- Company payroll burden (provisions)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS wca_company      numeric(12,2) DEFAULT 0,  -- Workmans Compensation Accrual
  ADD COLUMN IF NOT EXISTS staff_meals      numeric(12,2) DEFAULT 0,  -- Monthly staff meals value
  ADD COLUMN IF NOT EXISTS bonus_provision  numeric(12,2) DEFAULT 0,  -- 13th cheque / bonus monthly provision
  ADD COLUMN IF NOT EXISTS incentive        numeric(12,2) DEFAULT 0,  -- Monthly incentive provision
  ADD COLUMN IF NOT EXISTS leave_provision  numeric(12,2) DEFAULT 0,  -- Leave pay provision
  ADD COLUMN IF NOT EXISTS other_company_contrib numeric(12,2) DEFAULT 0;

-- Totals (derived but stored for performance)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS total_payroll_burden numeric(12,2) DEFAULT 0,  -- All company contributions + provisions
  ADD COLUMN IF NOT EXISTS total_cost           numeric(12,2) DEFAULT 0;  -- Basic + all deductions + all burden

-- Leave & bonus accrual (year-end calculations)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS leave_days           numeric(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS leave_accrual        numeric(12,2) DEFAULT 0,  -- Basic salary leave accrual value
  ADD COLUMN IF NOT EXISTS bonus_payout_factor  numeric(6,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_accrual_dec    numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_accrual_july   numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mgmt_incentive       numeric(12,2) DEFAULT 0;

-- ─── Refresh the latest_salary view to include new columns ───────────────────
DROP VIEW IF EXISTS latest_salary;
CREATE VIEW latest_salary AS
SELECT DISTINCT ON (sr.employee_id)
  sr.*,
  e.hotel_id,
  e.employee_code,
  e.surname,
  e.first_name,
  e.job_title,
  e.department_code,
  e.grade_label,
  e.category,
  e.job_grade,
  e.status,
  e.comments,
  e.employment_date,
  e.nmw_applicable
FROM salary_records sr
JOIN employees e ON e.id = sr.employee_id
ORDER BY sr.employee_id, sr.period_year DESC, sr.period_month DESC;
