-- Add percentage multiplier for leave accrual and bonus provision calculations
-- Formula: (basic × days / 365) × pct = monthly accrual
-- Default 1.0 = 100% (no change to existing calculations)

ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS leave_accrual_pct   DECIMAL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS bonus_provision_pct DECIMAL DEFAULT 1.0;
