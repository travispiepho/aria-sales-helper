#!/usr/bin/env node
// apply-coaching-prompts-migration.mjs
//
// Applies server/migrations/2026-08-30-coaching-prompts.sql to the live
// Neon production DATABASE_URL. Same standard migration mechanism as
// apply-coaching-stages-migration.mjs (plain Node + pg script reading the
// .sql file). Note: this migration's CREATE TABLE / seed statements are
// ALSO mirrored inside server.js's ensureSessionsTable(), so a normal
// deploy-from-main applies this automatically on server boot — this
// script exists so it can additionally be run by hand ahead of/independent
// of a deploy, matching this repo's established convention.
//
// Loads DATABASE_URL from ../../../.env.secrets without printing it.
// Prints a verification query result at the end (the 6 seeded prompts by
// key), matching the migration file's own suggested verification query.
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

const migrationPath = path.join(__dirname, '..', 'migrations', '2026-08-30-coaching-prompts.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    console.log(`Applying migration: ${migrationPath}`);
    await client.query(sql);
    console.log('Migration applied (or already-applied, since statements are IF NOT EXISTS / ON CONFLICT DO NOTHING).');

    const result = await client.query(
      `SELECT key, label, length(prompt_text) AS prompt_len, updated_at FROM coaching_prompts ORDER BY key ASC`
    );

    console.log('\nSeeded coaching_prompts (expect 6):');
    result.rows.forEach(r => {
      console.log(`  ${r.key} — ${r.label} (${r.prompt_len} chars)`);
    });

    if (result.rows.length < 6) {
      console.error(`\nERROR: Expected at least 6 prompts, found ${result.rows.length}.`);
      process.exit(1);
    }
    console.log(`\ncoaching_prompts table verified present in production with ${result.rows.length} rows.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
