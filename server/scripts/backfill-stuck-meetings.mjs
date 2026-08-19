#!/usr/bin/env node
/**
 * backfill-stuck-meetings.mjs — ONE-OFF BACKFILL SCRIPT. NOT RUN.
 *
 * ⚠️ DO NOT RUN THIS AGAINST PRODUCTION WITHOUT EXPLICIT SIGN-OFF. ⚠️
 *
 * Written 2026-08-05 as part of the root-cause fix for meetings getting
 * stuck `status = 'active'` forever when a client disconnects unexpectedly
 * (see server.js's `finalizeMeetingIfAbandoned` comment block, and
 * memory/aria-web-runaway-meetings-2026-08-04.md for the original
 * diagnosis). This script is the one-time cleanup for the meetings that
 * were ALREADY stranded before that server-side fix existed — the fix
 * itself only prevents *future* meetings from getting stuck; it does
 * nothing retroactively for rows already `active` with no live client.
 *
 * WHAT IT DOES (when run):
 *   1. SELECTs every meeting currently `status = 'active'`.
 *   2. Prints them for review (id, rep, started_at, age).
 *   3. Only if invoked with `--apply` (NOT the default): UPDATEs each of
 *      those rows to `status = 'interrupted'`, `ended_at = started_at`
 *      (best-effort placeholder end time — these meetings have no real end
 *      event to use; using `started_at` avoids fabricating a plausible-
 *      looking-but-fake duration. If a better convention is agreed with
 *      Gabe/Troy — e.g. `ended_at = NOW()`, or copying the last transcript
 *      segment's timestamp if one exists — swap that in before running).
 *
 * PREREQUISITE: this requires the `'interrupted'` status value to be a
 * valid CHECK-constraint value first — i.e.
 * `migrations/2026-08-05-meeting-interrupted-status.sql` must be applied
 * BEFORE this script's `--apply` mode is ever run, or every UPDATE will
 * fail the CHECK constraint. This script does NOT apply that migration
 * itself — that is a separate, explicit step requiring its own review.
 *
 * Default (no flags) mode is SELECT-only / read-only — safe to run
 * repeatedly at any time to re-check current state. `--apply` is the only
 * thing that writes, and this task was explicitly told NOT to run that
 * against production. This file is being delivered as reviewable content,
 * not as something already executed with --apply.
 *
 * Usage:
 *   node scripts/backfill-stuck-meetings.mjs            # SELECT + print only
 *   node scripts/backfill-stuck-meetings.mjs --apply     # NOT RUN — see above
 */

import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SELECT_SQL = `
  SELECT id, rep_id, customer_id, started_at, ended_at, status,
         now() - started_at AS age
  FROM meetings
  WHERE status = 'active'
  ORDER BY started_at ASC;
`;

// Uses started_at as the placeholder ended_at (see header note on why, and
// on why this is a decision worth Gabe/Troy input rather than a silent
// default). Only touches rows still 'active' at execution time — re-running
// this script after a partial/previous run is safe (idempotent: rows already
// flipped to 'interrupted' no longer match the WHERE clause).
const UPDATE_SQL = `
  UPDATE meetings
  SET status = 'interrupted',
      ended_at = COALESCE(ended_at, started_at)
  WHERE id = ANY($1) AND status = 'active'
  RETURNING id, status, ended_at;
`;

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(SELECT_SQL);
    console.log(`\nFound ${res.rows.length} meeting(s) with status = 'active':\n`);
    for (const row of res.rows) {
      console.log(JSON.stringify(row, null, 2));
    }

    if (!APPLY) {
      console.log('\n(dry run — no changes made. Re-run with --apply to update these rows, ' +
        'AFTER migrations/2026-08-05-meeting-interrupted-status.sql has been applied and Gabe/Troy have signed off.)');
      return;
    }

    // Deliberately unreachable in the delivered state of this task — see
    // file header. Left implemented (not stubbed) so review of the ACTUAL
    // update logic is possible without guessing what it would do.
    const ids = res.rows.map((r) => r.id);
    if (ids.length === 0) {
      console.log('\nNothing to update.');
      return;
    }
    const updateRes = await client.query(UPDATE_SQL, [ids]);
    console.log(`\nUpdated ${updateRes.rows.length} meeting(s):`);
    for (const row of updateRes.rows) {
      console.log(JSON.stringify(row, null, 2));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill script failed:', err);
  process.exit(1);
});
