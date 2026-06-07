-- Configurable payroll methods per hotel: rates, caps, amounts, CTC inclusion flags
-- Run via Supabase Dashboard → SQL Editor

ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS provident_ee_rate         numeric DEFAULT 0.07,
  ADD COLUMN IF NOT EXISTS provident_er_rate         numeric DEFAULT 0.07,
  ADD COLUMN IF NOT EXISTS provident_er_rate_senior  numeric DEFAULT 0.07,
  ADD COLUMN IF NOT EXISTS uif_rate                  numeric DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS uif_cap                   numeric DEFAULT 177.12,
  ADD COLUMN IF NOT EXISTS sdl_rate                  numeric DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS meals_standard            numeric DEFAULT 330,
  ADD COLUMN IF NOT EXISTS meals_manager             numeric DEFAULT 380,
  ADD COLUMN IF NOT EXISTS leave_days                numeric DEFAULT 24,
  ADD COLUMN IF NOT EXISTS bonus_days                numeric DEFAULT 30.42,
  -- CTC inclusion flags (true = include this ER item in the CTC total)
  ADD COLUMN IF NOT EXISTS ctc_provident_er          boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ctc_uif_er                boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ctc_sdl                   boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ctc_wca                   boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ctc_meals                 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ctc_leave_accrual         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ctc_bonus                 boolean DEFAULT false;

-- Botswana hotels: apply BW-specific statutory defaults
UPDATE hotels SET
  provident_ee_rate        = 0.05,
  provident_er_rate        = 0.045,
  provident_er_rate_senior = 0.09,
  leave_days               = 21,
  bonus_days               = 26
WHERE LOWER(country) LIKE '%botswana%' OR LOWER(country) = 'bw';
