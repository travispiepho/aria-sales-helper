#!/usr/bin/env node
// Read-only schema inspection script for Step 0 dedupe check.
// Loads DATABASE_URL from ../../.env.secrets without printing it.
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
  const v = line.slice(idx + 1).trim();
  if (k) process.env[k] = v;
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    const tables = ['meetings', 'transcript_segments', 'coaching_snapshots', 'voice_prints', 'users', 'customers'];
    for (const t of tables) {
      const res = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [t]
      );
      console.log(`\n=== ${t} ===`);
      for (const row of res.rows) {
        console.log(`  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable} | default=${row.column_default}`);
      }
    }

    // check for any BANT/insider/question/rebuttal related tables already
    const allTables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    console.log('\n=== ALL TABLES ===');
    console.log(allTables.rows.map(r => r.table_name).join(', '));

    // row counts for key tables
    for (const t of ['meetings', 'transcript_segments', 'coaching_snapshots']) {
      const c = await client.query(`SELECT COUNT(*) FROM ${t}`);
      console.log(`\n${t} row count: ${c.rows[0].count}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
