/**
 * test-auto-title.mjs — real-evidence harness for the mobile-only auto-title
 * feature (see generateAutoTitleForMeeting() in server.js).
 *
 * READ-ONLY against prod: SELECTs meetings + transcript_segments, makes the
 * REAL claude-haiku-4-5 call via OpenRouter with the EXACT same system/user
 * prompt + max_tokens + cleanup regex as server.js, and PRINTS the generated
 * title. It deliberately does NOT run the UPDATE — no prod writes from this
 * script. Run: node scripts/test-auto-title.mjs
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
  titleText = titleText.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.\s]+$/, '').trim();
  return { title: titleText, usage: data.usage };
}

const main = async () => {
  // Real mobile-started meetings with enough transcript (>= 3 segments, the
  // same floor server.js uses).
  const { rows: meetings } = await pool.query(`
    SELECT m.id, m.title, m.status, m.origin_client, m.started_at,
           (SELECT count(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id)::int AS seg_count
    FROM meetings m
    WHERE m.origin_client = 'mobile'
      AND (SELECT count(*) FROM transcript_segments ts WHERE ts.meeting_id = m.id) >= 3
    ORDER BY m.started_at DESC
    LIMIT 3
  `);

  console.log(`Found ${meetings.length} real mobile-started meetings with >=3 transcript segments.\n`);

  let totalPromptTokens = 0, totalCompletionTokens = 0;

  for (const m of meetings) {
    const { rows: segs } = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
      [m.id]
    );
    const transcriptText = segs.map(s => `${s.speaker}: ${s.text}`).join('\n');
    const { title, usage } = await generateTitle(transcriptText);
    totalPromptTokens += usage?.prompt_tokens || 0;
    totalCompletionTokens += usage?.completion_tokens || 0;
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`meeting_id     : ${m.id}`);
    console.log(`origin_client  : ${m.origin_client}`);
    console.log(`status         : ${m.status}`);
    console.log(`existing title : ${m.title === null ? 'NULL' : JSON.stringify(m.title)}`);
    console.log(`segments       : ${m.seg_count}  (transcript chars: ${transcriptText.length})`);
    console.log(`transcript head: ${transcriptText.slice(0, 180).replace(/\n/g, ' | ')}…`);
    console.log(`>>> GENERATED TITLE: "${title}"   (${title.split(/\s+/).length} words)`);
    console.log(`    tokens: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens}`);
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log(`TOTAL tokens across ${meetings.length} calls: prompt=${totalPromptTokens} completion=${totalCompletionTokens}`);
  // claude-haiku-4-5 pricing (OpenRouter): $1.00/M input, $5.00/M output
  const cost = (totalPromptTokens / 1e6) * 1.0 + (totalCompletionTokens / 1e6) * 5.0;
  console.log(`Approx cost for these ${meetings.length} titles: $${cost.toFixed(6)}  (~$${(cost / meetings.length).toFixed(6)}/meeting)`);

  // ── Exclusion evidence: how many web-started meetings would be skipped ──
  const { rows: webRows } = await pool.query(`
    SELECT origin_client, count(*)::int AS n
    FROM meetings GROUP BY origin_client ORDER BY origin_client
  `);
  console.log('\nMeetings by origin_client in prod (auto-title only fires for mobile):');
  for (const r of webRows) console.log(`  ${r.origin_client}: ${r.n}`);

  await pool.end();
};

main().catch(e => { console.error(e); process.exit(1); });
