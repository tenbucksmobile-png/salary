-- Allow employee_code to be null (ANO positions have no employee yet)
ALTER TABLE employees ALTER COLUMN employee_code DROP NOT NULL;
