-- Add severance provision column (Botswana entities)
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS severance numeric NOT NULL DEFAULT 0;
