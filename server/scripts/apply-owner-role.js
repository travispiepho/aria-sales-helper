// One-time runner for migrations/2026-08-10-owner-role.sql.
// Applies the migration inside a single transaction, then prints
// verification output (owner rows + live CHECK constraint definition).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const secretsPath = path.resolve(__dirname, '../../../.env.secrets');
const raw = fs.readFileSync(secretsPath, 'utf8');
const m = raw.match(/^DATABASE_URL=(.*)$/m);
if (!m) throw new Error('DATABASE_URL not found in .env.secrets');
const DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');

const sqlPath = path.resolve(__dirname, '../migrations/2026-08-10-owner-role.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('Applying migrations/2026-08-10-owner-role.sql ...');
await pool.query(sql);
console.log('Applied.\n');

const owners = await pool.query(
  "SELECT email, role, deactivated_at IS NULL AS active FROM users WHERE role = 'owner'"
);
console.log(`=== owner rows (expect exactly 1: thacker@certapro.com) ===`);
console.log(`count = ${owners.rowCount}`);
for (const r of owners.rows) console.log(`  ${r.email} | ${r.role} | active=${r.active}`);

const all = await pool.query(
  'SELECT email, role FROM users ORDER BY role, email'
);
console.log('\n=== all users ===');
for (const r of all.rows) console.log(`  ${r.role.padEnd(6)} | ${r.email}`);

const con = await pool.query(`
  SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass AND contype = 'c'
`);
console.log('\n=== live users CHECK constraint (from pg_constraint) ===');
for (const c of con.rows) console.log(`  ${c.conname}: ${c.def}`);

await pool.end();
