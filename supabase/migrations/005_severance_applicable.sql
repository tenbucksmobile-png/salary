-- Add per-employee flag controlling severance accrual calculation (Botswana)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS severance_applicable boolean NOT NULL DEFAULT false;
