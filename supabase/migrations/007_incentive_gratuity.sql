-- Per-employee incentive and gratuity flags
ALTER TABLE employees ADD COLUMN IF NOT EXISTS incentive_applicable  boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS incentive_multiplier  int     NOT NULL DEFAULT 2;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS gratuity_applicable   boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS gratuity_rate         numeric NOT NULL DEFAULT 0;

-- Gratuity monthly provision column on salary records
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS gratuity numeric NOT NULL DEFAULT 0;
