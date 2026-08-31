-- 2026-08-30-setup-call-project-info.sql
--
-- aria_setup_call_coaching_differentiation
--
-- Backs the new "setup-call coaching mode" for over-the-phone Setup Call
-- meetings (see server.js's runCoachingAnalysis() branch + the new
-- SETUP_CALL_COACHING_SYSTEM_PROMPT). Gabe's framing: "Every over-the-
-- phone call on aria is just a Setup_call where the rep collects the
-- basic information about the project and sets up an in person meeting
-- and time... The over the phone setup call should be collecting
-- information about the project during the call that can be referenced
-- later." The 11-stage walkthrough coaching (stage/checklist/progress
-- bar — see coaching_stages, migrations/2026-08-30-coaching-stages.sql)
-- describes an IN-PERSON walkthrough's flow and does not apply to a
-- 5-minute phone scheduling call; this table is the "referenced later"
-- persistence the brief asks for.
--
-- WHY A NEW TABLE, NOT NEW COLUMNS ON `meetings`:
--   - `meetings` is already a wide, general-purpose row shared by every
--     channel (in_person / phone / uploaded_recording). Setup-call project
--     info is meaningful ONLY for phone setup-call meetings, and the field
--     list here is expected to grow/iterate (this is brand-new coaching
--     logic, not a settled schema) — a side table keeps that iteration off
--     the hot, heavily-touched `meetings` row and avoids yet another
--     "ALTER TABLE meetings ADD COLUMN" for a narrow-purpose feature (this
--     repo already has ~20 additive migrations against meetings; see
--     ensureSessionsTable()'s history).
--   - One-to-one with the meeting (a phone call has exactly one project-info
--     record, continuously upserted as the call progresses) — a single-row-
--     per-meeting table with meeting_id as the PK (not a separate surrogate
--     id) makes "upsert the current snapshot" a plain
--     INSERT ... ON CONFLICT (meeting_id) DO UPDATE, mirroring the
--     "once done always done"/merge convention coaching_snapshots already
--     established, but WITHOUT that table's append-only history model:
--     project info fields should never be missed once observed (later
--     mentions confirm/refine earlier ones), so a single mutable row that
--     the extraction pass merges into (not overwrites wholesale) is the
--     right persistence shape.
--
-- Schema conventions followed (matching coaching_stages/objections in this
-- same file's sibling migrations):
--   - UUID PRIMARY KEY for other new tables in this repo, but here
--     meeting_id itself IS the primary key (see one-to-one reasoning
--     above) — same pattern as checklist_progress's composite PK in
--     migrate.js, just simpler (single-column PK instead of composite).
--   - created_at/updated_at TIMESTAMPTZ DEFAULT NOW()
--   - JSONB for the actual extracted-field payload (see field list below)
--     rather than one column per fact: the extraction is LLM-driven and the
--     field list is explicitly called out in the brief as "use your
--     judgment" / likely to evolve — a JSONB blob lets the coaching-prompt
--     side iterate the field list without a follow-up migration each time,
--     matching this repo's existing appetite for JSONB on judgment-call/
--     evolving shapes (coaching_snapshots.snapshot, meetings.speaker_labels,
--     users' none — but voice_prints.features is the closest analogue).
--
-- FIELD LIST (documented here, authoritative source in the coaching output
-- contract — see this task's final report for the full frontend-facing
-- contract). Nested inside the `project_info` JSONB column:
--   customer_name          text|null   — spoken name if not already linked to a customers row
--   customer_address       text|null   — spoken/confirmed address
--   project_type           text|null   — e.g. "exterior repaint", "deck staining"
--   scope_notes            text|null   — free-text scope/rooms/areas mentioned
--   approx_size_sqft       number|null — rough size if a number was mentioned
--   timeline_urgency       text|null   — e.g. "ASAP", "before winter", "no rush"
--   budget_signal          text|null   — any budget/price-range language surfaced
--   appointment_set        boolean     — whether an in-person visit date/time was agreed
--   appointment_date_time  text|null   — ISO-ish or natural-language date/time if set
--   notes                  text|null   — anything else worth carrying forward
--
-- `source` and `confidence` are NOT modeled per-field in v1 (see report for
-- the follow-up recommendation) — this is a first pass at "capture it so a
-- human can read it before the in-person visit," not a fully provenance-
-- tracked structured-data pipeline.

BEGIN;

CREATE TABLE IF NOT EXISTS setup_call_project_info (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  project_info JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

-- Verification query (reference for hand-testing):
--   SELECT meeting_id, project_info, updated_at FROM setup_call_project_info
--   WHERE meeting_id = '<id>';
