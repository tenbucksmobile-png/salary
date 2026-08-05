-- BURS: allow the "combined" submission group (CSL/NL/CFEM/PomPom) to be
-- uploaded as four separate per-hotel payroll files instead of one shared
-- spreadsheet. 'combined' is kept in the allowed set for backward
-- compatibility with any already-stored rows from before this change — new
-- uploads use the hotel's own lowercased short_code as upload_group.

ALTER TABLE burs_uploads DROP CONSTRAINT burs_uploads_upload_group_check;
ALTER TABLE burs_uploads ADD CONSTRAINT burs_uploads_upload_group_check
  CHECK (upload_group IN ('ilg', 'combined', 'csl', 'nl', 'cfem', 'pompom'));
