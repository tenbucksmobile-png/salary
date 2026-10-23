-- BURS: CSL and NL each get a second upload slot for their Fixed Term
-- Contract payroll workbook, alongside the main payroll spreadsheet. Only
-- FTC staff with PAYE are carried into the combined ITW8 export.

ALTER TABLE burs_uploads DROP CONSTRAINT burs_uploads_upload_group_check;
ALTER TABLE burs_uploads ADD CONSTRAINT burs_uploads_upload_group_check
  CHECK (upload_group IN ('ilg', 'combined', 'csl', 'nl', 'cfem', 'pompom', 'csl_ftc', 'nl_ftc'));
