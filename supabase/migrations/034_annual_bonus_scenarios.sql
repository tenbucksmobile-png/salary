-- Annual Bonus: the actual bonus payment schedule (Budget → Annual Bonus).
-- Separate from the Bonus Provision page (an accrual) and from
-- increase_scenarios / scenario_lines (Salary Review) — the Dashboard and
-- fetchScenarioLineMap() read those, so bonus drafts must never live there.
-- One draft per hotel per bonus year; settings_json holds the page's form
-- state (pct, flat, excludedGrades, overrides, excluded).

CREATE TABLE annual_bonus_scenarios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid REFERENCES hotels(id) ON DELETE CASCADE NOT NULL,
  period_year    int NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  settings_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE(hotel_id, period_year)
);

ALTER TABLE annual_bonus_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all ON annual_bonus_scenarios FOR ALL TO anon USING (true) WITH CHECK (true);
