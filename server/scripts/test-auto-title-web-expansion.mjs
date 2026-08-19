/**
 * test-auto-title-web-expansion.mjs — real-evidence harness for the
 * 2026-08-05 follow-up pass (aria-auto-title-web-expansion): confirms the
 * generalized (origin-agnostic) auto-title logic produces real titles for
 * BOTH web-started and mobile-started meetings, using the EXACT same
 * prompt/model/cleanup as generateAutoTitleForMeeting() in server.js.
 *
 * READ-ONLY against prod: SELECTs meetings + transcript_segments, makes
 * REAL claude-haiku-4-5 calls via OpenRouter, and PRINTS the generated
 * titles + word counts (no length enforcement — evidence gathering only).
 * Does NOT run any UPDATE against prod. Run: node scripts/test-auto-title-web-expansion.mjs
 */

import { readFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;

const envText = readFileSync(new URL('../../../.env.secrets', import.meta.url), 'utf-8');
function envVal(key) {
  const line = envText.split('\n').find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}
const DATABASE_URL = envVal('DATABASE_URL');
const OPENROUTER_API_KEY = envVal('OPENROUTER_KEY') || envVal('OPENROUTER_API_KEY');

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── EXACT copy of the prompt + cleanup from server.js's generateAutoTitleForMeeting ──
const TITLE_SYSTEM = `You write short, plain-English meeting titles for sales-call transcripts. Read the transcript and output ONE title only — no quotes, no punctuation at the end, no preamble, no explanation. 3 to 9 words. It should describe what the call was actually about (e.g. "Kitchen cabinet refinish estimate walkthrough", "Follow-up on flooring quote pricing"). Do not mention speaker names or "Speaker 1/2" labels.`;

async function generateTitle(transcriptText) {
  const TITLE_USER = `Transcript:\n\n${transcriptText.slice(0, 6000)}\n\nOutput only the title.`;
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
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data)}`);
  let titleText = data.choices?.[0]?.message?.content || null;
  if (!titleText) return { title: null, usage: data.usage };
  // Same cleanup as server.js: strip wrapping quotes/trailing punctuation —
  // NOT length enforcement, just formatting cleanup. Whatever word count
  // results is printed as-is below (no rejection/regeneration).
  titleText = titleText.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.\s]+$/, '').trim();
  return { title: titleText, usage: data.usage };
}

async function testGroup(label, originClient, limit) {
  const { rows: meetings } = await pool.query(`
    SELECT m.id, m.title, m.status, m.origin_client, m.started_at,
           (SELECT count(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id)::int AS seg_count
    FROM meetings m
    WHERE m.origin_client = $1
      AND (SELECT count(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) >= 3
    ORDER BY m.started_at DESC
    LIMIT $2
  `, [originClient, limit]);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`${label} — found ${meetings.length} real ${originClient}-started meetings with >=3 segments`);
  console.log(`════════════════════════════════════════════════════════════════`);

  const results = [];
  for (const m of meetings) {
    const { rows: segs } = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
      [m.id]
    );
    const transcriptText = segs.map(s => `${s.speaker}: ${s.text}`).join('\n');
    const { title, usage } = await generateTitle(transcriptText);
    const wordCount = title ? title.split(/\s+/).filter(Boolean).length : 0;
    const inRange = wordCount >= 3 && wordCount <= 9;
    results.push({ meetingId: m.id, originClient, title, wordCount, inRange });
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`meeting_id     : ${m.id}`);
    console.log(`origin_client  : ${m.origin_client}`);
    console.log(`status         : ${m.status}`);
    console.log(`existing title : ${m.title === null ? 'NULL' : JSON.stringify(m.title)}`);
    console.log(`segments       : ${m.seg_count}  (transcript chars: ${transcriptText.length})`);
    console.log(`transcript head: ${transcriptText.slice(0, 180).replace(/\n/g, ' | ')}…`);
    console.log(`>>> GENERATED TITLE: "${title}"   (${wordCount} words, ${inRange ? 'WITHIN' : 'OUTSIDE'} 3-9 guidance range)`);
    console.log(`    tokens: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens}`);
  }
  return results;
}

const main = async () => {
  const webResults = await testGroup('WEB-STARTED MEETINGS (new — proving generalized logic works)', 'web', 3);
  const mobileResults = await testGroup('MOBILE-STARTED MEETINGS (regression check — confirm still works)', 'mobile', 2);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log('SUMMARY — word counts (no programmatic enforcement; guidance-only in prompt)');
  console.log(`════════════════════════════════════════════════════════════════`);
  for (const r of [...webResults, ...mobileResults]) {
    console.log(`  [${r.originClient}] ${r.meetingId}: "${r.title}" — ${r.wordCount} words (${r.inRange ? 'within 3-9' : 'OUTSIDE 3-9 — stored anyway, no rejection'})`);
  }

  await pool.end();
};

main().catch(e => { console.error(e); process.exit(1); });
