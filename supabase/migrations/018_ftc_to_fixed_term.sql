-- Rename the "FTC" grade_label value to "Fixed Term" everywhere it appears.
-- The app previously stored the canonical grade for fixed-term employees as
-- "FTC"; this reverses that back to the more readable "Fixed Term" label.
UPDATE employees
SET grade_label = 'Fixed Term'
WHERE grade_label = 'FTC';
