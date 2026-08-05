#!/usr/bin/env node
/**
 * investigate-stuck-meetings.mjs — READ-ONLY investigation script.
 *
 * Part of the 2026-08-05 root-cause fix for meetings getting stuck in
 * `active` status forever when a client disconnects unexpectedly
 * (backgrounding, network drop, crash) instead of hitting the explicit
 * "End Meeting" -> PATCH /api/meetings/:id path.
 *
 * This script ONLY runs SELECT queries against the production Neon DB
 * (via DATABASE_URL from app/server/.env.secrets or the environment). It
 * does NOT write anything. Run it with:
 *
 *   node scripts/investigate-stuck-meetings.mjs
 *
 * Output: every meeting currently `status = 'active'`, ordered oldest
 * first, with how long it's been active — useful both for this
 * investigation and as an ad-hoc ops tool going forward.
 */

import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Export it or run with `env $(cat ../../.env.secrets | grep DATABASE_URL) node scripts/investigate-stuck-meetings.mjs`.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SELECT_STUCK_MEETINGS_SQL = `
  SELECT
    m.id,
    m.rep_id,
    u.name AS rep_name,
    m.customer_id,
    c.name AS customer_name,
    m.started_at,
    m.ended_at,
    m.status,
    now() - m.started_at AS age
  FROM meetings m
  LEFT JOIN users u ON m.rep_id = u.id
  LEFT JOIN customers c ON m.customer_id = c.id
  WHERE m.status = 'active'
  ORDER BY m.started_at ASC;
`;

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(SELECT_STUCK_MEETINGS_SQL);
    console.log(`\nFound ${res.rows.length} meeting(s) with status = 'active':\n`);
    for (const row of res.rows) {
      console.log(JSON.stringify(row, null, 2));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Investigation query failed:', err);
  process.exit(1);
});
