-- Per-hotel draft scenarios: each hotel keeps its own draft until committed
-- Run via Supabase Dashboard → SQL Editor

ALTER TABLE increase_scenarios
  ADD COLUMN IF NOT EXISTS hotel_id      uuid REFERENCES hotels(id),
  ADD COLUMN IF NOT EXISTS settings_json jsonb;
