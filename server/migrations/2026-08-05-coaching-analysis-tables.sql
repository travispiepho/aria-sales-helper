-- 2026-08-05-coaching-analysis-tables.sql
--
-- ARIA Priority 1 roadmap (Travis, via Gabe, 2026-08-04 23:12 CDT relay):
-- items 1 (BANT + closing certainty), 3 (insider-language flagger), and
-- 4 (question-listening gaps). Item 6 (coaching report) is a pure
-- read-aggregation endpoint and needs NO new schema of its own — it just
-- joins these tables + the existing coaching_snapshots/analytics data.
--
-- STATUS: WRITTEN, NOT APPLIED. Per this task's explicit hard rule, this
-- was NOT run against the live Neon prod DATABASE_URL. It is proposal-only,
-- pending Gabe/Troy review, following the exact same "write but don't
-- auto-run" precedent set by the 2026-08-04 pyannoteAI/Twilio scaffolding
-- migrations in this same migrations/ directory.
--
-- Safety notes:
--   * All three tables are strictly additive (CREATE TABLE IF NOT EXISTS) —
--     zero risk to existing tables/data. No ALTER TABLE on any existing
--     table is needed for this pass.
--   * ON DELETE CASCADE on meeting_id matches the existing convention used
--     by transcript_segments, checklist_progress, suggestions, and
--     measurements in migrate.js's base schema.
--   * Analyses are re-run (manually or after each meeting completes) and
--     overwrite/replace prior results for that meeting rather than
--     accumulating unbounded history — see server.js's coachingAnalysis.js
--     module for the delete-then-insert (flags/gaps) and
--     upsert-on-conflict (bant_scores) application logic. This keeps a
--     "current analysis state per meeting" mental model, matching how
--     voice_prints already does one-row-per-user upserts, rather than the
--     ever-growing-history model coaching_snapshots uses (which needs
--     history because it's a live per-turn feed, not a single settled
--     analysis).

-- ─── Item 1: BANT + closing certainty ───────────────────────────────────────
-- One row per meeting (upserted on re-run). Score 0-100 per BANT factor
-- plus one overall closing-certainty percentage, with the LLM's rationale
-- text for each factor kept alongside for the UI / manager report.
CREATE TABLE IF NOT EXISTS bant_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  budget_score INTEGER NOT NULL CHECK (budget_score BETWEEN 0 AND 100),
  authority_score INTEGER NOT NULL CHECK (authority_score BETWEEN 0 AND 100),
  need_score INTEGER NOT NULL CHECK (need_score BETWEEN 0 AND 100),
  timeline_score INTEGER NOT NULL CHECK (timeline_score BETWEEN 0 AND 100),
  closing_certainty_pct INTEGER NOT NULL CHECK (closing_certainty_pct BETWEEN 0 AND 100),
  rationale JSONB NOT NULL DEFAULT '{}',
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (meeting_id)
);

-- ─── Item 3: Insider-language flagger ───────────────────────────────────────
-- Multiple rows per meeting — one per flagged jargon/insider phrase found in
-- the rep's speech. `ts`/`minutes_in` are copied from the actual matched
-- transcript_segments row (not LLM-hallucinated) so timestamps are trustworthy.
CREATE TABLE IF NOT EXISTS insider_language_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  segment_index INTEGER,
  ts TIMESTAMPTZ,
  minutes_in NUMERIC,
  phrase TEXT NOT NULL,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insider_language_flags_meeting_id
  ON insider_language_flags (meeting_id);

-- ─── Item 4: Question-listening gaps ────────────────────────────────────────
-- Multiple rows per meeting — one per prospect question the rep's
-- subsequent response did not address. Same "real timestamp from the actual
-- segment" approach as insider_language_flags above.
CREATE TABLE IF NOT EXISTS question_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  question_segment_index INTEGER,
  question_text TEXT NOT NULL,
  question_ts TIMESTAMPTZ,
  question_minutes_in NUMERIC,
  rep_response_excerpt TEXT,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_gaps_meeting_id
  ON question_gaps (meeting_id);

-- ─── Verification query (run manually after applying, if applied) ──────────
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public'
--   AND table_name IN ('bant_scores', 'insider_language_flags', 'question_gaps')
--   ORDER BY table_name;
