-- Clear incorrect employee codes for Chobe Safari Lodge and Nata Lodge
UPDATE employees
SET employee_code = NULL
WHERE hotel_id IN (
  SELECT id FROM hotels WHERE short_code IN ('CSL', 'NL')
);
