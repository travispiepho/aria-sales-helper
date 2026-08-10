#!/usr/bin/env node
/**
 * migrate.js — Runs the Postgres schema migration against the Neon DB.
 * Usage: node migrate.js
 */

import pg from 'pg';
import bcrypt from 'bcrypt';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('rep', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 2026-08-10: soft-delete flag for admin account deletion feature. NULL
  -- for active accounts, set to NOW() when an admin deactivates a user via
  -- DELETE /api/admin/users/:id. See server.js's ensureSessionsTable() for
  -- the mirroring idempotent ALTER TABLE that keeps existing prod DBs in
  -- sync on server boot.
  deactivated_at TIMESTAMPTZ
);
-- Idempotent add for DBs that predate the column above (fresh installs
-- get it via CREATE TABLE; upgrades get it via this ALTER).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  rep_id UUID REFERENCES users(id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  summary TEXT
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ DEFAULT NOW(),
  speaker TEXT,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  items JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checklist_progress (
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'satisfied', 'skipped')),
  evidence_ts TIMESTAMPTZ,
  PRIMARY KEY (meeting_id, item_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ DEFAULT NOW(),
  type TEXT,
  text TEXT NOT NULL,
  acknowledged BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  label TEXT,
  value_m NUMERIC,
  method TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running schema migration...');
    await client.query(schema);
    console.log('Schema migration complete.');

    // Seed admin user for Troy with real bcrypt hash
    const tempPassword = 'TempPass123!';
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
    `, ['Troy Hacker', 'troy@certaprograndhaven.com', passwordHash, 'admin']);

    console.log('Admin user seeded (or already existed).');

    // Verify all 8 tables exist
    const tables = [
      'users', 'customers', 'meetings', 'transcript_segments',
      'checklist_templates', 'checklist_progress', 'suggestions', 'measurements'
    ];

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      ORDER BY table_name
    `, [tables]);

    const found = result.rows.map(r => r.table_name);
    const missing = tables.filter(t => !found.includes(t));

    console.log('\nTable verification:');
    tables.forEach(t => {
      const exists = found.includes(t);
      console.log(`  ${exists ? '✓' : '✗'} ${t}`);
    });

    if (missing.length > 0) {
      console.error(`\nERROR: Missing tables: ${missing.join(', ')}`);
      process.exit(1);
    } else {
      console.log('\nAll 8 tables verified. Migration successful!');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
