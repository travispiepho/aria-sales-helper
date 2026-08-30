#!/usr/bin/env node
/**
 * sublog.mjs
 *
 * Reusable wrapper around the three SubLogs lifecycle operations (spawn,
 * queue/dequeue, close) so future subagent spawn/queue/close events are ONE
 * command instead of hand-written inline Python each time. Standing project
 * rule: memory/silos/subagent-protocols.md rules 7-13 (mirrored in the
 * aria_hard_rules Google Doc, section 2.9) require every subagent lifecycle
 * event to be logged to the "Running/Queues" Google Sheet, SubLogs tab.
 *
 * Sheet: Running/Queues (ID 1viryxPngPCGXdwAZshfAy0RsvImBYkLHn1b7Hc-HtHc)
 * Tab:   SubLogs — column A = taskName, B = ISO start, C = ISO end.
 *
 * Credential fetching mirrors scripts/fetch-doc-sa.mjs's Railway-fresh-pull
 * pattern: RAILWAY_TOKEN is loaded from .env.secrets, then used to pull
 * GOOGLE_SERVICE_ACCOUNT_JSON fresh from Railway env vars every run (never
 * trusts a possibly-stale local copy). Same Railway project/env/service IDs
 * as fetch-doc-sa.mjs. One deliberate deviation from that script, noted here
 * because the brief asked to mirror it "exactly": fetch-doc-sa.mjs's GraphQL
 * call uses an `Authorization: Bearer <token>` header, which independently
 * verified as REJECTED ("Not Authorized") for this project-scoped Railway
 * token during this task's live testing. The header that actually
 * authenticates a project-scoped token is `Project-Access-Token: <token>`
 * (same convention already documented in memory/CORE_RULES.md and used by
 * projects/siro-sales-helper/verify-creds.sh). This script uses that working
 * header. If fetch-doc-sa.mjs itself is ever fixed/updated, no action is
 * needed here — this is a separate, additive file.
 *
 * Also writes (not read-only) so the OAuth scope requested is
 * https://www.googleapis.com/auth/spreadsheets (full, not .readonly).
 *
 * Usage:
 *   node scripts/sublog.mjs spawn   <taskName>
 *   node scripts/sublog.mjs queue   <taskName>
 *   node scripts/sublog.mjs dequeue <taskName>
 *   node scripts/sublog.mjs close   <taskName>
 *   node scripts/sublog.mjs status
 *
 * Exit codes: 0 = success. Non-zero = error, message on stderr, nothing
 * false-positive on stdout.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHEET_ID = '1viryxPngPCGXdwAZshfAy0RsvImBYkLHn1b7Hc-HtHc';
const TAB = 'SubLogs';
const RANGE = `${TAB}!A:C`;

const RAILWAY_PROJECT_ID = '85706f43-7bec-44e2-97f8-079d4c43fe90';
const RAILWAY_ENV_ID = 'db05b291-780d-4d95-8cf1-8e8fd43ffc65';
const RAILWAY_SERVICE_ID = 'da41e2cd-839f-4065-9caf-855ad73cef9e';

// --- Path resolution helpers -------------------------------------------
// This script may live either inside the versioned app repo's scripts/ dir
// (../server/node_modules, ../../.env.secrets) or, per the existing local
// convention, in the parent siro-sales-helper/scripts/ dir alongside
// fetch-doc-sa.mjs (../app/server/node_modules, ../.env.secrets). Try both
// so it works from either location without edits.

function firstExisting(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Absolute fallbacks are included deliberately: this script is committed
// inside the app repo's scripts/ dir (canonical location app/scripts/), but
// in practice it also gets run from ad-hoc git worktrees at other physical
// depths (e.g. projects/siro-sales-helper/worktrees/<task>/scripts/), where
// relative ../../.env.secrets math no longer lines up. This is a stable,
// single-tenant environment (not a portable package), so a known-absolute
// fallback is safe and avoids silent misresolution across worktree depths.
const SECRETS_FILE = firstExisting([
  path.join(__dirname, '..', '.env.secrets'),
  path.join(__dirname, '..', '..', '.env.secrets'),
  path.join(__dirname, '..', '..', '..', '.env.secrets'),
  '/root/.openclaw/workspace/projects/siro-sales-helper/.env.secrets',
]);

const GOOGLEAPIS_INDEX = firstExisting([
  path.join(__dirname, '..', 'server', 'node_modules', 'googleapis', 'build', 'src', 'index.js'),
  path.join(__dirname, '..', 'app', 'server', 'node_modules', 'googleapis', 'build', 'src', 'index.js'),
  path.join(__dirname, '..', '..', 'app', 'server', 'node_modules', 'googleapis', 'build', 'src', 'index.js'),
  '/root/.openclaw/workspace/projects/siro-sales-helper/app/server/node_modules/googleapis/build/src/index.js',
]);

function readSecrets() {
  if (!SECRETS_FILE) {
    throw new Error('.env.secrets not found (checked ../.env.secrets and ../../.env.secrets relative to this script)');
  }
  const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  // Resolve simple ${VAR} references (e.g. RAILWAY_TOKEN=${RAILWAY_API_TOKEN}).
  for (const key of Object.keys(out)) {
    out[key] = out[key].replace(/\$\{([A-Z_]+)\}/g, (_, name) => (out[name] !== undefined ? out[name] : ''));
  }
  return out;
}

async function getGoogleServiceAccountJson(railwayToken) {
  const query = `query { variables(projectId: "${RAILWAY_PROJECT_ID}", environmentId: "${RAILWAY_ENV_ID}", serviceId: "${RAILWAY_SERVICE_ID}") }`;
  const resp = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Project-Access-Token': railwayToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await resp.json();
  const b64 = data?.data?.variables?.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!b64) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON not found in Railway variables response: ' +
        JSON.stringify(data).slice(0, 500)
    );
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function getSheetsClient() {
  if (!GOOGLEAPIS_INDEX) {
    throw new Error('googleapis module not found (checked ../app/server/node_modules and ../server/node_modules relative to this script)');
  }
  const { google } = await import(GOOGLEAPIS_INDEX);
  const secrets = readSecrets();
  const { RAILWAY_TOKEN } = secrets;
  if (!RAILWAY_TOKEN) {
    throw new Error('RAILWAY_TOKEN missing from .env.secrets. Cannot pull GOOGLE_SERVICE_ACCOUNT_JSON.');
  }
  const credentials = await getGoogleServiceAccountJson(RAILWAY_TOKEN);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function apiErrorMessage(err) {
  const data = err?.response?.data;
  if (data) {
    try {
      return typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      /* fall through */
    }
  }
  return err?.message || String(err);
}

function rowFromUpdatedRange(updatedRange) {
  // e.g. "SubLogs!A97:C97" -> 97
  const m = updatedRange.match(/![A-Z]+(\d+)/);
  if (!m) throw new Error(`Could not parse row number from updatedRange: ${updatedRange}`);
  return parseInt(m[1], 10);
}

async function appendRow(sheets, values) {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
  const updatedRange = res.data.updates.updatedRange;
  return rowFromUpdatedRange(updatedRange);
}

async function getAllValues(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
  });
  return res.data.values || [];
}

async function updateCell(sheets, cellRange, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!${cellRange}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

// --- Subcommands ---------------------------------------------------------

async function cmdSpawn(taskName) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString();
  const row = await appendRow(sheets, [taskName, now, '']);
  console.log(`ROW=${row}`);
}

async function cmdQueue(taskName) {
  const sheets = await getSheetsClient();
  const row = await appendRow(sheets, [taskName, '', '']);
  console.log(`ROW=${row}`);
}

async function cmdDequeue(taskName) {
  const sheets = await getSheetsClient();
  const values = await getAllValues(sheets);
  // Find name-only rows (col A exact match, col B currently blank).
  const matches = [];
  values.forEach((row, i) => {
    const name = row[0];
    const start = row[1];
    if (name === taskName && isBlank(start)) {
      matches.push(i + 1); // 1-based sheet row number
    }
  });
  if (matches.length === 0) {
    console.error(`ERROR: no queued (blank-start) row found for taskName "${taskName}" in SubLogs!A:C`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `WARNING: ${matches.length} blank-start rows found for taskName "${taskName}" (rows ${matches.join(', ')}). ` +
        `Filling in the most recently-added one (highest row number) — verify this is correct.`
    );
  }
  const row = matches[matches.length - 1];
  const now = new Date().toISOString();
  await updateCell(sheets, `B${row}`, now);
  console.log(`ROW=${row}`);
}

async function cmdClose(taskName) {
  const sheets = await getSheetsClient();
  const values = await getAllValues(sheets);
  // Find rows for this taskName where col C (End) is currently blank.
  const matches = [];
  values.forEach((row, i) => {
    const name = row[0];
    const end = row[2];
    if (name === taskName && isBlank(end)) {
      matches.push(i + 1);
    }
  });
  if (matches.length === 0) {
    console.error(`ERROR: no open (blank-end) row found for taskName "${taskName}" in SubLogs!A:C`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `WARNING: ${matches.length} blank-end rows found for taskName "${taskName}" (rows ${matches.join(', ')}). ` +
        `Closing the most recently-added one (highest row number) — verify this is correct, this shouldn't normally happen.`
    );
  }
  const row = matches[matches.length - 1];
  const now = new Date().toISOString();
  await updateCell(sheets, `C${row}`, now);
  console.log(`ROW=${row}`);
}

async function cmdStatus() {
  const sheets = await getSheetsClient();
  const values = await getAllValues(sheets);
  // Skip header row if present (row 1 literally "Name","Start","End").
  const startIdx = values.length && values[0][0] === 'Name' ? 1 : 0;
  const dataRows = values.slice(startIdx);
  const last15 = dataRows.slice(-15);
  const baseRowNum = startIdx + (dataRows.length - last15.length) + 1;

  const rows = last15.map((row, i) => {
    const rowNum = baseRowNum + i;
    const name = row[0] || '';
    const start = row[1] || '';
    const end = row[2] || '';
    let state;
    if (!isBlank(start) && !isBlank(end)) state = 'closed';
    else if (!isBlank(start) && isBlank(end)) state = 'open';
    else state = 'queued';
    return { rowNum, name, start, end, state };
  });

  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const startWidth = Math.max(5, ...rows.map((r) => r.start.length));
  const endWidth = Math.max(3, ...rows.map((r) => r.end.length));

  const pad = (s, w) => String(s).padEnd(w);
  console.log(
    `${pad('ROW', 5)} ${pad('NAME', nameWidth)} ${pad('START', startWidth)} ${pad('END', endWidth)} STATE`
  );
  for (const r of rows) {
    console.log(
      `${pad(r.rowNum, 5)} ${pad(r.name, nameWidth)} ${pad(r.start, startWidth)} ${pad(r.end, endWidth)} ${r.state}`
    );
  }
}

async function main() {
  const [cmd, taskName] = process.argv.slice(2);
  if (!cmd) {
    console.error('Usage: node scripts/sublog.mjs <spawn|queue|dequeue|close> <taskName>');
    console.error('       node scripts/sublog.mjs status');
    process.exit(2);
  }

  try {
    switch (cmd) {
      case 'spawn':
        if (!taskName) throw new Error('spawn requires <taskName>');
        await cmdSpawn(taskName);
        break;
      case 'queue':
        if (!taskName) throw new Error('queue requires <taskName>');
        await cmdQueue(taskName);
        break;
      case 'dequeue':
        if (!taskName) throw new Error('dequeue requires <taskName>');
        await cmdDequeue(taskName);
        break;
      case 'close':
        if (!taskName) throw new Error('close requires <taskName>');
        await cmdClose(taskName);
        break;
      case 'status':
        await cmdStatus();
        break;
      default:
        throw new Error(`Unknown subcommand "${cmd}". Use spawn|queue|dequeue|close|status.`);
    }
  } catch (err) {
    console.error(`ERROR: ${apiErrorMessage(err)}`);
    process.exit(1);
  }
}

main();
