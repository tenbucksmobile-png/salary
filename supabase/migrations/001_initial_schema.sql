-- IHG Salary Management System — Initial Schema
-- Run in Supabase SQL Editor (Dashboard → SQL Editor)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Hotels ───────────────────────────────────────────────────────────────────
CREATE TABLE hotels (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  short_code  text NOT NULL UNIQUE,
  country     text NOT NULL DEFAULT 'South Africa',
  created_at  timestamptz DEFAULT now()
);

INSERT INTO hotels (name, short_code, country) VALUES
  ('Indaba Hotel',                'IH',   'South Africa'),
  ('Indaba Lodge Gaborone',       'ILG',  'Botswana'),
  ('Nata Lodge',                  'NL',   'Botswana'),
  ('Chobe Safari Lodge',          'CSL',  'Botswana'),
  ('Indaba Lodge Richards Bay',   'ILRB', 'South Africa'),
  ('African Procurement Agencies','APA',  'South Africa');

-- ─── Employees ────────────────────────────────────────────────────────────────
CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id        uuid NOT NULL REFERENCES hotels(id),
  employee_code   text NOT NULL,
  surname         text NOT NULL,
  first_name      text NOT NULL,
  aka             text,
  id_number       text,
  job_title       text,
  department_code text,
  paypoint        text,
  category        integer,
  job_grade       integer,
  grade_label     text,   -- ANO / Front Line / Supervisory / Middle Mgmt / Management / Exec
  employment_date date,   -- populated from second CSV
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','terminated','on_leave')),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (hotel_id, employee_code)
);

-- ─── Payroll imports log ──────────────────────────────────────────────────────
CREATE TABLE payroll_imports (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id            uuid NOT NULL REFERENCES hotels(id),
  filename            text NOT NULL,
  period_month        integer NOT NULL,
  period_year         integer NOT NULL,
  employees_added     integer DEFAULT 0,
  employees_updated   integer DEFAULT 0,
  employees_flagged   integer DEFAULT 0,
  status              text NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed','rejected')),
  imported_at         timestamptz DEFAULT now()
);

-- ─── Salary records (one snapshot per employee per import) ────────────────────
CREATE TABLE salary_records (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  import_id             uuid REFERENCES payroll_imports(id),
  period_month          integer NOT NULL,
  period_year           integer NOT NULL,
  -- Earnings
  basic_salary          numeric(12,2) DEFAULT 0,
  allowances            jsonb DEFAULT '{}',
  total_earnings        numeric(12,2) DEFAULT 0,
  -- Employee deductions
  tax_paye              numeric(12,2) DEFAULT 0,
  uif_employee          numeric(12,2) DEFAULT 0,
  medical_employee      numeric(12,2) DEFAULT 0,
  ancilla_employee      numeric(12,2) DEFAULT 0,
  provident_employee    numeric(12,2) DEFAULT 0,
  total_deductions      numeric(12,2) DEFAULT 0,
  -- Company contributions
  uif_company           numeric(12,2) DEFAULT 0,
  medical_company       numeric(12,2) DEFAULT 0,
  provident_company     numeric(12,2) DEFAULT 0,
  sdl_company           numeric(12,2) DEFAULT 0,
  ancilla_company       numeric(12,2) DEFAULT 0,
  total_company_contrib numeric(12,2) DEFAULT 0,
  -- Summary
  net_salary            numeric(12,2) DEFAULT 0,
  ctc                   numeric(12,2) DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  UNIQUE (employee_id, period_year, period_month)
);

-- ─── Salary increase scenarios ────────────────────────────────────────────────
CREATE TABLE increase_scenarios (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           text NOT NULL,
  description    text,
  effective_date date NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','committed')),
  created_at     timestamptz DEFAULT now(),
  committed_at   timestamptz
);

CREATE TABLE scenario_lines (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id     uuid NOT NULL REFERENCES increase_scenarios(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  hotel_id        uuid NOT NULL REFERENCES hotels(id),
  increase_pct    numeric(6,4) NOT NULL,
  current_basic   numeric(12,2) NOT NULL,
  new_basic       numeric(12,2) NOT NULL,
  increase_amount numeric(12,2) NOT NULL,
  current_ctc     numeric(12,2) DEFAULT 0,
  new_ctc         numeric(12,2) DEFAULT 0
);

-- ─── RLS — allow full anon access (app uses password middleware) ──────────────
ALTER TABLE hotels             ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_imports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE increase_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_lines     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all" ON hotels             FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON employees          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON payroll_imports    FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON salary_records     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON increase_scenarios FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON scenario_lines     FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── Helpful view: latest salary per employee ─────────────────────────────────
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
  e.status
FROM salary_records sr
JOIN employees e ON e.id = sr.employee_id
ORDER BY sr.employee_id, sr.period_year DESC, sr.period_month DESC;
