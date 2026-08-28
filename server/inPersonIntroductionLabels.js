import { isLikelyName } from './nameHeuristics.js';

export const INTRODUCTION_WINDOW_MS = 30_000;

const NAME_TOKEN = String.raw`[\p{L}\p{M}][\p{L}\p{M}'’\-]{1,39}`;
const NAME_CAPTURE = `(${NAME_TOKEN})`;
const ELIGIBLE_CHANNELS = new Set(['in_person', 'uploaded_recording']);
const ROLE_OR_COMPANY = new Set([
  'acme', 'aria', 'certapro', 'painter', 'painters', 'painting', 'sales', 'salesperson',
  'representative', 'rep', 'customer', 'client', 'homeowner', 'owner', 'manager',
  'estimator', 'contractor', 'company', 'team', 'office', 'meeting', 'thanks',
  'sir', 'maam', 'madam', 'friend', 'there', 'everyone', 'folks', 'guys',
]);

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{M}'-]+/gu, ' ')
    .trim();
}

function displayName(raw) {
  const value = String(raw || '').normalize('NFKC').replace(/’/g, "'").trim();
  return value
    .split(/([-'])/u)
    .map((part) => (/^\p{L}/u.test(part) ? part.charAt(0).toLocaleUpperCase('en-US') + part.slice(1).toLocaleLowerCase('en-US') : part))
    .join('');
}

function validatedName(raw) {
  const normalized = normalizeName(raw);
  if (!normalized || normalized.split(/\s+/u).length !== 1 || ROLE_OR_COMPANY.has(normalized)) return null;
  if (/^[A-Za-z'’-]+$/u.test(String(raw)) && !isLikelyName(raw)) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M}'’\-]{1,39}$/u.test(String(raw)) ? displayName(raw) : null;
}

function nameMatchesCanonical(canonicalName, spokenName) {
  if (!canonicalName || !spokenName) return false;
  const spokenParts = normalizeName(spokenName).split(/\s+/u).filter(Boolean);
  const canonicalParts = new Set(normalizeName(canonicalName).split(/\s+/u).filter(Boolean));
  return spokenParts.length > 0 && spokenParts.every((part) => canonicalParts.has(part));
}

export function isEligibleInPersonMeeting(meeting) {
  return ELIGIBLE_CHANNELS.has(meeting?.channel) && !meeting?.call_sid;
}

/**
 * Parse deliberately narrow, two-party opening language. A returned object
 * describes evidence that the current slot is the authenticated rep; the
 * customer's name is only a candidate until a different diarized slot exists.
 */
export function parseTwoPersonIntroduction(text) {
  const input = String(text || '').normalize('NFKC').trim();
  if (!input || input.length > 300) return null;

  const patterns = [
    {
      id: 'address_then_self',
      re: new RegExp(String.raw`^(?:hi|hello|hey)\s+${NAME_CAPTURE}\s*[,!;]\s*(?:this\s+is|i(?:'|’)?m|i\s+am|my\s+name\s+is)\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
      customerGroup: 1, selfGroup: 2, confidence: 0.99,
    },
    {
      id: 'customer_thanks',
      re: new RegExp(String.raw`^${NAME_CAPTURE}\s*[,!;]\s*(?:thanks|thank\s+you)\s+for\s+(?:meeting|joining|your\s+time)\b(?=$|[\s,.!?;])`, 'iu'),
      customerGroup: 1, selfGroup: null, confidence: 0.94,
    },
    {
      id: 'self_then_customer',
      re: new RegExp(String.raw`^(?:hi|hello|hey)?\s*[,!;]?\s*(?:i(?:'|’)?m|i\s+am|my\s+name\s+is)\s+${NAME_CAPTURE}(?:\s+with\s+[\p{L}\p{M}&'’.-]{2,30})?\s*[,;]?\s*(?:and\s+)?this\s+is\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
      selfGroup: 1, customerGroup: 2, confidence: 0.98,
    },
    {
      id: 'self_here_with',
      re: new RegExp(String.raw`^(?:hi|hello|hey)?\s*[,!;]?\s*(?:i(?:'|’)?m|i\s+am|my\s+name\s+is)\s+${NAME_CAPTURE}\s*[,;]?\s*(?:and\s+)?(?:i(?:'|’)?m|i\s+am)\s+here\s+with\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
      selfGroup: 1, customerGroup: 2, confidence: 0.98,
    },
    {
      id: 'self_then_you_are',
      re: new RegExp(String.raw`^(?:hi|hello|hey)?\s*[,!;]?\s*(?:i(?:'|’)?m|i\s+am|my\s+name\s+is)\s+${NAME_CAPTURE}(?:\s+with\s+[\p{L}\p{M}&'’.-]{2,30})?\s*[,;]?\s*(?:and\s+)?you(?:'|’)?re\s+${NAME_CAPTURE}\s*,?\s*right\s*\??$`, 'iu'),
      selfGroup: 1, customerGroup: 2, confidence: 0.96,
    },
    {
      id: 'self_only',
      re: new RegExp(String.raw`^(?:hi|hello|hey)?\s*[,!;]?\s*(?:i(?:'|’)?m|i\s+am|my\s+name\s+is)\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
      selfGroup: 1, customerGroup: null, confidence: 0.97,
    },
  ];

  for (const pattern of patterns) {
    const match = pattern.re.exec(input);
    if (!match) continue;
    const tail = input.slice(match[0].length);
    if (tail.replace(/[\s,.!?;:]+/gu, '')) continue;
    const selfName = pattern.selfGroup ? validatedName(match[pattern.selfGroup]) : null;
    const customerName = pattern.customerGroup ? validatedName(match[pattern.customerGroup]) : null;
    if ((pattern.selfGroup && !selfName) || (pattern.customerGroup && !customerName)) continue;
    if (selfName && customerName && normalizeName(selfName) === normalizeName(customerName)) return null;
    return {
      selfName,
      customerName,
      pattern: pattern.id,
      confidence: pattern.confidence,
      evidenceText: input,
      repEvidence: selfName ? 'self_introduction' : 'host_address',
    };
  }
  return null;
}

/**
 * Deterministic two-person label state machine shared by live room audio and
 * uploaded recordings. It never assumes slot zero/first is the rep and never
 * assigns the pending customer to the rep's sole provisional slot.
 */
export function createInPersonIntroductionLabeler({
  meetingType,
  repDisplayName,
  customerDisplayName = null,
  existingLocks = {},
  existingEvidence = {},
  startedAtMs = Date.now(),
  resolveIdentity,
  onConflict = () => {},
  now = () => Date.now(),
}) {
  const enabled = ELIGIBLE_CHANNELS.has(meetingType);
  const locks = new Map();
  const lockSources = new Map();
  const aliases = new Map();
  const observedSlots = new Set();
  let pending = null;
  let conflicted = false;

  for (const [index, lock] of Object.entries(existingLocks || {})) {
    if (!lock?.name) continue;
    locks.set(String(index), lock.name);
    lockSources.set(String(index), lock.source || 'manual');
  }

  const persistedCustomerNames = new Set(
    Object.values(existingEvidence || {})
      .filter((evidence) => evidence?.method === 'introduction' && evidence.role === 'customer')
      .map((evidence) => normalizeName(evidence.customer_name || evidence.resolved_name))
      .filter(Boolean),
  );
  for (const [index, evidence] of Object.entries(existingEvidence || {})) {
    if (
      evidence?.method === 'introduction' && evidence.role === 'rep' &&
      evidence.customer_candidate && locks.has(String(index)) &&
      !persistedCustomerNames.has(normalizeName(evidence.customer_candidate))
    ) {
      pending = {
        repIndex: String(index),
        customerName: evidence.customer_candidate,
        intro: { pattern: evidence.pattern || 'persisted', confidence: evidence.confidence || 0.9 },
        introSegment: { id: evidence.transcript_segment_id, ts: evidence.transcript_ts },
        customerSource: evidence.customer_source || 'introduction',
      };
    }
  }

  function canonical(rawIndex) {
    let current = String(rawIndex);
    let hops = 0;
    while (aliases.has(current) && hops++ < 8) current = aliases.get(current);
    return current;
  }

  function conflict(value) {
    conflicted = true;
    pending = null;
    onConflict(value);
    return { conflict: value };
  }

  async function resolve(index, name, role, intro, segment, confidence, extraEvidence = {}) {
    const si = canonical(index);
    const current = locks.get(si);
    if (current) return { resolved: false, reason: normalizeName(current) === normalizeName(name) ? 'idempotent' : 'locked' };
    const evidence = {
      method: 'introduction', role, confidence,
      transcript_segment_id: segment?.id || null,
      transcript_ts: segment?.ts || new Date(now()).toISOString(),
      pattern: intro.pattern,
      ...extraEvidence,
    };
    locks.set(si, name);
    lockSources.set(si, 'introduction_pending');
    const result = await resolveIdentity({ speakerIndex: Number(si), name, role, evidence });
    if (result?.resolved === false) {
      locks.delete(si);
      lockSources.delete(si);
      return result;
    }
    lockSources.set(si, 'introduction');
    return { resolved: true, name, evidence };
  }

  async function resolvePendingCustomer(triggerSegment) {
    if (!pending || conflicted) return null;
    const others = [...observedSlots].filter((slot) => slot !== pending.repIndex);
    if (others.length === 0) return null;
    if (others.length !== 1) return conflict({
      reason: 'ambiguous_customer_slot', repIndex: Number(pending.repIndex), candidateIndices: others.map(Number),
    });
    const customerIndex = others[0];
    const current = locks.get(customerIndex);
    if (current && normalizeName(current) !== normalizeName(pending.customerName)) {
      return conflict({ reason: 'customer_slot_already_locked', speakerIndex: Number(customerIndex) });
    }
    const state = pending;
    pending = null;
    const result = await resolve(
      customerIndex, state.customerName, 'customer', state.intro,
      state.introSegment, state.intro.confidence,
      {
        customer_source: state.customerSource,
        customer_name: state.customerName,
        resolved_name: state.customerName,
        rep_speaker_index: Number(state.repIndex),
        distinct_speaker_segment_id: triggerSegment?.id || null,
        distinct_speaker_ts: triggerSegment?.ts || null,
      },
    );
    return { customer: result };
  }

  async function onSegment(segment) {
    if (!enabled) return { enabled: false };
    const timestampMs = segment.timestampMs ?? (Date.parse(segment.ts || '') || now());
    const si = canonical(segment.speakerIndex);
    observedSlots.add(si);

    // A customer candidate remains pending beyond the extraction window: if
    // Deepgram exposes one provisional slot for 30+ seconds, the first truly
    // distinct slot still resolves it immediately when it finally appears.
    const lateResolution = await resolvePendingCustomer(segment);
    if (lateResolution) return lateResolution;
    if (conflicted || timestampMs - startedAtMs > INTRODUCTION_WINDOW_MS) return { enabled: true };

    const intro = parseTwoPersonIntroduction(segment.text);
    if (!intro) return pending ? { pendingCustomer: true } : { enabled: true };
    if (intro.selfName && !nameMatchesCanonical(repDisplayName, intro.selfName)) {
      return conflict({
        reason: 'authenticated_rep_name_conflict', speakerIndex: Number(si),
        accountName: repDisplayName, spokenName: intro.selfName, segmentId: segment.id || null,
      });
    }
    if (!repDisplayName) {
      return conflict({ reason: 'missing_authenticated_rep_name', speakerIndex: Number(si), segmentId: segment.id || null });
    }

    let customerName = intro.customerName;
    let customerSource = 'introduction';
    if (customerDisplayName) {
      if (customerName && !nameMatchesCanonical(customerDisplayName, customerName)) {
        return conflict({
          reason: 'associated_customer_name_conflict', speakerIndex: Number(si),
          associatedName: customerDisplayName, spokenName: customerName, segmentId: segment.id || null,
        });
      }
      customerName = customerDisplayName;
      customerSource = intro.customerName ? 'customer_association_confirmed_by_introduction' : 'customer_association';
    }
    if (!customerName) return { repEvidenceOnly: true };

    if (pending && (
      pending.repIndex !== si || normalizeName(pending.customerName) !== normalizeName(customerName)
    )) {
      return conflict({
        reason: 'conflicting_introduction_evidence', speakerIndex: Number(si),
        priorRepIndex: Number(pending.repIndex), priorCustomerName: pending.customerName, customerName,
      });
    }

    const current = locks.get(si);
    if (current && normalizeName(current) !== normalizeName(repDisplayName)) {
      return conflict({ reason: 'existing_lock_conflict', speakerIndex: Number(si) });
    }
    const repResult = await resolve(
      si, repDisplayName, 'rep', intro, segment, intro.confidence,
      {
        account_name: repDisplayName,
        rep_evidence: intro.repEvidence,
        spoken_rep_name: intro.selfName,
        customer_candidate: customerName,
        customer_source: customerSource,
      },
    );
    if (repResult.reason === 'locked') return conflict({ reason: 'existing_lock_conflict', speakerIndex: Number(si) });

    pending = { repIndex: si, customerName, intro, introSegment: segment, customerSource };
    const immediate = await resolvePendingCustomer(segment);
    return immediate || { rep: repResult, pendingCustomer: true };
  }

  function addAlias(rawIndex, canonicalIndex) {
    const raw = canonical(rawIndex);
    const target = canonical(canonicalIndex);
    if (raw === target) return { aliased: false, reason: 'same' };
    if (locks.has(raw) || locks.has(target)) return { aliased: false, reason: 'locked' };
    aliases.set(raw, target);
    return { aliased: true };
  }

  function setManualLock(index, name) {
    const si = canonical(index);
    locks.set(si, name);
    lockSources.set(si, 'manual');
    // A human decision is authoritative. Drop any automatic counterpart
    // inference rather than carrying stale evidence past that intervention.
    if (pending) pending = null;
  }

  return {
    enabled, onSegment, addAlias, setManualLock,
    getLock: (index) => locks.get(canonical(index)),
    getLockSource: (index) => lockSources.get(canonical(index)),
    canMerge: (rawIndex, canonicalIndex) => !locks.has(canonical(rawIndex)) && !locks.has(canonical(canonicalIndex)),
    _state: () => ({ pending, conflicted, observedSlots: new Set(observedSlots), locks: new Map(locks), existingEvidence }),
  };
}

/** Atomically persist one identity and relabel all prior generic rows. */
export async function persistIntroductionResolution({ pool, meetingId, speakerIndex, name, evidence }) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const speakerId = `Speaker ${Number(speakerIndex) + 1}`;
  const si = String(speakerIndex);
  try {
    await client.query('BEGIN');
    const meetingResult = await client.query(
      `UPDATE meetings
       SET speaker_labels = COALESCE(speaker_labels, '{}'::jsonb) || jsonb_build_object($4::text, $1::text),
           speaker_label_evidence = COALESCE(speaker_label_evidence, '{}'::jsonb) || jsonb_build_object($5::text, $2::jsonb)
       WHERE id = $3
         AND NOT (COALESCE(speaker_labels, '{}'::jsonb) ? $4)
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_each_text(COALESCE(speaker_labels, '{}'::jsonb)) AS existing(label, value)
           WHERE lower(existing.value) = lower($1::text)
         )
       RETURNING speaker_labels, speaker_label_evidence`,
      [name, JSON.stringify(evidence), meetingId, speakerId, si],
    );
    if (meetingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { resolved: false, reason: 'persisted_lock_won', speakerId, relabeledCount: 0 };
    }
    const relabelResult = await client.query(
      `UPDATE transcript_segments SET speaker = $1 WHERE meeting_id = $2 AND speaker = $3`,
      [name, meetingId, speakerId],
    );
    await client.query('COMMIT');
    return {
      resolved: true, speakerId, relabeledCount: relabelResult.rowCount || 0,
      speakerLabels: meetingResult.rows[0].speaker_labels,
      speakerLabelEvidence: meetingResult.rows[0].speaker_label_evidence,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw err;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

export const _internals = { normalizeName, nameMatchesCanonical, validatedName };
