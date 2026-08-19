#!/usr/bin/env node
// apply-coaching-analysis-migration.mjs
//
// Applies server/migrations/2026-08-05-coaching-analysis-tables.sql to the
// live Neon production DATABASE_URL. This is the standard migration
// mechanism used by this repo for post-initial-schema migrations (plain
// Node + pg script reading the .sql file, matching the convention already
// used by migrate.js for the base schema and by backfill-stuck-meetings.mjs
// / inspect-schema.js for other DB scripts in this same scripts/ dir).
//
// Loads DATABASE_URL from ../../../.env.secrets without printing it.
// Prints a verification query result at the end (table existence check,
// matching the migration file's own suggested verification query).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretsPath = path.join(__dirname, '..', '..', '..', '.env.secrets');
const content = fs.readFileSync(secretsPath, 'utf8');
for (const line of content.split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const idx = line.indexOf('=');
  const k = line.slice(0, idx).trim();
  let v = line.slice(idx + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (k) process.env[k] = v;
}

const migrationPath = path.join(__dirname, '..', 'migrations', '2026-08-05-coaching-analysis-tables.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    console.log(`Applying migration: ${migrationPath}`);
    await client.query(sql);
    console.log('Migration applied (or already-applied, since statements are IF NOT EXISTS).');

    const tables = ['bant_scores', 'insider_language_flags', 'question_gaps'];
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [tables]
    );
    const found = result.rows.map(r => r.table_name);
    const missing = tables.filter(t => !found.includes(t));

    console.log('\nTable verification:');
    tables.forEach(t => {
      console.log(`  ${found.includes(t) ? '✓' : '✗'} ${t}`);
    });

    if (missing.length > 0) {
      console.error(`\nERROR: Missing tables after migration: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('\nAll 3 coaching-analysis tables verified present in production.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
