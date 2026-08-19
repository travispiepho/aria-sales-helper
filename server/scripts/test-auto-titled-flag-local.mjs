/**
 * test-auto-titled-flag-local.mjs — verifies generateAutoTitleForMeeting()'s
 * WRITE behavior (setting auto_titled = true) against a LOCAL test
 * Postgres DB (NOT prod) using a real seeded meeting + real transcript
 * segments. Uses a REAL OpenRouter API call for the title generation
 * itself, then runs the EXACT SAME UPDATE statement server.js uses and
 * queries the row back to prove auto_titled flips to true.
 *
 * Run: DATABASE_URL=postgres://aria_autotitle:aria_autotitle@localhost:5432/aria_autotitle_test node scripts/test-auto-titled-flag-local.mjs
 */
import { readFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL to the LOCAL test DB.'); process.exit(1); }

const envText = readFileSync(new URL('../../../.env.secrets', import.meta.url), 'utf-8');
function envVal(key) {
  const line = envText.split('\n').find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}
const OPENROUTER_API_KEY = envVal('OPENROUTER_KEY') || envVal('OPENROUTER_API_KEY');

const pool = new Pool({ connectionString: DATABASE_URL });

const TITLE_SYSTEM = `You write short, plain-English meeting titles for sales-call transcripts. Read the transcript and output ONE title only — no quotes, no punctuation at the end, no preamble, no explanation. 3 to 9 words. It should describe what the call was actually about (e.g. "Kitchen cabinet refinish estimate walkthrough", "Follow-up on flooring quote pricing"). Do not mention speaker names or "Speaker 1/2" labels.`;

// ── EXACT copy of generateAutoTitleForMeeting() from server.js, minus the
// fastify.log calls (replaced with console) and minus the ANTHROPIC branch
// (this env only has OPENROUTER configured) — everything else (SQL text,
// cleanup regex, guards) is identical to what's now live in server.js. ──
async function generateAutoTitleForMeeting(meetingId) {
  if (!OPENROUTER_API_KEY) return null;

  let segments;
  try {
    const segResult = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
      [meetingId]
    );
    segments = segResult.rows;
  } catch (err) {
    console.error(`auto-title: DB error fetching segments for ${meetingId}: ${err.message}`);
    return null;
  }

  if (segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const TITLE_USER = `Transcript:\n\n${transcriptText.slice(0, 6000)}\n\nOutput only the title.`;

  let titleText = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aria.certaprograndhaven.com',
        'X-Title': 'ARIA Sales Helper',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        max_tokens: 40,
        messages: [
          { role: 'system', content: TITLE_SYSTEM },
          { role: 'user', content: TITLE_USER },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`auto-title: OpenRouter error for ${meetingId}: ${JSON.stringify(data)}`);
      return null;
    }
    titleText = data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error(`auto-title: generation error for ${meetingId}: ${err.message}`);
    return null;
  }

  if (!titleText) return null;

  titleText = titleText.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.\s]+$/, '').trim();
  if (!titleText) return null;

  try {
    // SAME UPDATE as server.js as of this pass — sets auto_titled = true.
    const result = await pool.query(
      `UPDATE meetings SET title = $1, auto_titled = true WHERE id = $2 AND (title IS NULL OR title = '') RETURNING id, title, auto_titled`,
      [titleText, meetingId]
    );
    if (result.rows.length === 0) {
      console.log(`auto-title: skipped write for ${meetingId} — title already set.`);
      return null;
    }
    console.log('UPDATE returned row:', result.rows[0]);
  } catch (err) {
    console.error(`auto-title: failed to save title for ${meetingId}: ${err.message}`);
    return null;
  }

  return titleText;
}

const MEETING_ID = '22222222-2222-2222-2222-222222222222';

const before = await pool.query('SELECT id, title, auto_titled, origin_client FROM meetings WHERE id = $1', [MEETING_ID]);
console.log('BEFORE:', before.rows[0]);

const title = await generateAutoTitleForMeeting(MEETING_ID);
console.log('Generated title:', title, `(${title ? title.split(/\s+/).length : 0} words)`);

const after = await pool.query('SELECT id, title, auto_titled, origin_client FROM meetings WHERE id = $1', [MEETING_ID]);
console.log('AFTER:', after.rows[0]);

if (after.rows[0].auto_titled !== true) {
  console.error('FAIL: auto_titled was not set to true');
  process.exit(1);
}
console.log('PASS: auto_titled correctly set to true after auto-generation.');

await pool.end();
