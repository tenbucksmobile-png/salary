-- Adds a 4th wca_manual_entries type: 'provision_held' — records a
-- contingency provision the company keeps on its books against the risk
-- that an open dispute (e.g. a penalty/interest waiver) doesn't fully
-- succeed. Purely informational (like discrepancy_note) — does not feed
-- into the Adjusted Balance calc, which already assumes disputes succeed
-- in full. The entry's description carries the calculation breakdown.

ALTER TABLE wca_manual_entries DROP CONSTRAINT wca_manual_entries_entry_type_check;
ALTER TABLE wca_manual_entries ADD CONSTRAINT wca_manual_entries_entry_type_check
  CHECK (entry_type IN ('payment_not_reflected', 'dispute_raised', 'discrepancy_note', 'provision_held'));
