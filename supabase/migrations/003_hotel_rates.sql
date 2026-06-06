-- Migration 003 — WCA rate per hotel
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS wca_rate numeric(8,6) DEFAULT 0.0050;

COMMENT ON COLUMN hotels.wca_rate IS 'Workmens Compensation Assessment rate as a decimal (e.g. 0.0050 = 0.50%). SA hotels only — set to 0 for Botswana.';
