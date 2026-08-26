import { isLikelyName, toDisplayName } from './nameHeuristics.js';

export const INTRODUCTION_WINDOW_MS = 60_000;
export const CUSTOMER_RESPONSE_WINDOW_MS = 30_000;
export const CUSTOMER_RESPONSE_MAX_SEGMENTS = 6;

const NAME_TOKEN = String.raw`[\p{L}\p{M}][\p{L}\p{M}'’\-]{1,39}`;
const NAME_CAPTURE = `(${NAME_TOKEN})`;
const ROLE_OR_COMPANY = new Set([
  'certapro', 'painter', 'painters', 'painting', 'sales', 'salesperson',
  'representative', 'rep', 'customer', 'client', 'homeowner', 'owner',
  'manager', 'estimator', 'contractor', 'company', 'team', 'office',
]);
const EXPLICIT_SELF_CONFIRMATION_RE = /^(?:yes[,!]?\s+|yeah[,!]?\s+|yep[,!]?\s+)?(?:i(?:'|’)?m|i am|my name is)\s+/iu;
const ADJACENT_IDENTITY_ACK_RE = /^(?:yes|yeah|yep|correct|right)[,!]?\s+(?:that(?:'|’)?s me|that is me)\b|^(?:that(?:'|’)?s me|that is me)\b/iu;

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
  if (!normalized || normalized.split(/\s+/u).length !== 1) return null;
  if (ROLE_OR_COMPANY.has(normalized)) return null;
  // The legacy dictionary helper is ASCII-only. Keep its valuable common-word
  // rejection for ASCII names, but do not erase valid Unicode names merely
  // because its normalizer predates Unicode-property escapes.
  if (/^[A-Za-z'’-]+$/u.test(String(raw)) && !isLikelyName(raw)) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M}'’\-]{1,39}$/u.test(String(raw)) ? displayName(raw) : null;
}

export function isEligibleInPersonMeeting(meeting) {
  return meeting?.channel === 'in_person' && !meeting?.call_sid;
}

function accountMatchesSpokenName(accountName, spokenName) {
  if (!accountName) return true;
  const spoken = normalizeName(spokenName);
  const accountParts = new Set(normalizeName(accountName).split(/\s+/u).filter(Boolean));
  return accountParts.has(spoken);
}

/**
 * Parse only explicit two-person introductions spoken in the first person.
 * The intentionally narrow grammar rejects free-form mentions, lists, titles,
 * and third-party introductions. One-token names avoid swallowing company or
 * role words while supporting Unicode letters, apostrophes and hyphens.
 */
export function parseTwoPersonIntroduction(text) {
  const input = String(text || '').normalize('NFKC').trim();
  if (!input || input.length > 300) return null;

  const selfPrefix = String.raw`(?:^|[.!?]\s+|\bhi[,!]?\s+|\bhello[,!]?\s+)(?:i(?:'|’)?m|i am|my name is)\s+${NAME_CAPTURE}`;
  // Context-only company clause: bounded to at most three list-free tokens.
  // Neither these words nor a role can ever become the person's label.
  const companyClause = String.raw`(?:\s+with\s+[\p{L}\p{M}&'’.-]{2,30})?`;
  const patterns = [
    {
      id: 'this_is',
      re: new RegExp(String.raw`${selfPrefix}${companyClause}\s*[,;]?\s*(?:and\s+)?this\s+is\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
    },
    {
      id: 'you_are_right',
      re: new RegExp(String.raw`${selfPrefix}${companyClause}\s*[,;]?\s*(?:and\s+)?you(?:'|’)?re\s+${NAME_CAPTURE}\s*,?\s*right\s*\??(?=$|\s)`, 'iu'),
    },
    {
      id: 'here_with',
      re: new RegExp(String.raw`${selfPrefix}\s*(?:,|;)?\s*(?:and\s+)?(?:i(?:'|’)?m|i am)\s+here\s+with\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu'),
    },
  ];

  for (const { id, re } of patterns) {
    const match = re.exec(input);
    if (!match) continue;
    const selfName = validatedName(match[1]);
    const customerName = validatedName(match[2]);
    if (!selfName || !customerName || normalizeName(selfName) === normalizeName(customerName)) return null;

    // Any substantive tail means the utterance may discuss or introduce more
    // than these two people. Trailing punctuation alone is harmless.
    const tail = input.slice((match.index || 0) + match[0].length);
    if (tail.replace(/[\s,.!?;:]+/gu, '')) return null;

    return {
      selfName,
      customerName,
      pattern: id,
      confidence: id === 'you_are_right' ? 0.96 : 0.98,
      evidenceText: input,
    };
  }
  return null;
}

/**
 * Stateful, dependency-injected in-person introduction resolver. It never
 * records audio; evidence references the transcript segment already stored.
 */
export function createInPersonIntroductionLabeler({
  meetingType,
  repDisplayName,
  existingLocks = {},
  existingEvidence = {},
  startedAtMs = Date.now(),
  resolveIdentity,
  onConflict = () => {},
  now = () => Date.now(),
}) {
  const enabled = meetingType === 'in_person';
  const locks = new Map();
  const lockSources = new Map();
  const aliases = new Map();
  let segmentOrdinal = 0;
  let pending = null;

  for (const [index, lock] of Object.entries(existingLocks || {})) {
    if (!lock?.name) continue;
    locks.set(String(index), lock.name);
    lockSources.set(String(index), lock.source || 'manual');
  }

  function canonical(rawIndex) {
    let current = String(rawIndex);
    let hops = 0;
    while (aliases.has(current) && hops++ < 8) current = aliases.get(current);
    return current;
  }

  async function resolve(index, name, role, intro, segment, confidence, contextSegment = null) {
    const si = canonical(index);
    const current = locks.get(si);
    if (current) return { resolved: false, reason: current === name ? 'idempotent' : 'locked' };
    const evidence = {
      method: 'introduction',
      role,
      confidence,
      transcript_segment_id: segment.id || null,
      transcript_ts: segment.ts || new Date(now()).toISOString(),
      pattern: intro.pattern,
      context_segment_id: contextSegment?.id || null,
      context_ts: contextSegment?.ts || null,
    };
    // Mark locally before awaiting persistence so concurrent Deepgram message
    // handlers cannot resolve this slot twice. Roll back only if persistence
    // reports that an authoritative label won the race.
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

  async function onSegment(segment) {
    segmentOrdinal += 1;
    if (!enabled) return { enabled: false };
    const timestampMs = segment.timestampMs ?? (Date.parse(segment.ts || '') || now());
    const si = canonical(segment.speakerIndex);

    if (timestampMs - startedAtMs <= INTRODUCTION_WINDOW_MS) {
      const intro = parseTwoPersonIntroduction(segment.text);
      if (intro) {
        if (!accountMatchesSpokenName(repDisplayName, intro.selfName)) {
          const conflict = {
            reason: 'authenticated_rep_name_conflict',
            speakerIndex: Number(si),
            accountName: repDisplayName,
            spokenName: intro.selfName,
            segmentId: segment.id || null,
          };
          onConflict(conflict);
          return { conflict };
        }

        const repName = repDisplayName || intro.selfName;
        const repResult = await resolve(si, repName, 'rep', intro, segment, intro.confidence);
        if (repResult.reason === 'locked' && locks.get(si) !== repName) {
          return { conflict: { reason: 'existing_lock_conflict', speakerIndex: Number(si) } };
        }

        pending = {
          intro,
          repIndex: si,
          introSegment: segment,
          introOrdinal: segmentOrdinal,
          expiresAt: timestampMs + CUSTOMER_RESPONSE_WINDOW_MS,
          candidateIndex: null,
          candidateTurns: 0,
          candidateConfirmedIdentity: false,
          distinctOtherIndices: new Set(),
        };
        return { rep: repResult, pendingCustomer: true };
      }
    }

    if (!pending) return { enabled: true };
    if (
      timestampMs > pending.expiresAt ||
      segmentOrdinal - pending.introOrdinal > CUSTOMER_RESPONSE_MAX_SEGMENTS
    ) {
      pending = null;
      return { expired: true };
    }
    if (si === pending.repIndex) return { pendingCustomer: true };

    pending.distinctOtherIndices.add(si);
    if (pending.distinctOtherIndices.size > 1) {
      pending = null;
      return { ambiguous: true };
    }

    if (pending.candidateIndex !== si) {
      pending.candidateIndex = si;
      pending.candidateTurns = 0;
      pending.candidateConfirmedIdentity = false;
    }
    pending.candidateTurns += 1;
    const candidateText = String(segment.text || '').normalize('NFKC').trim();
    const explicitSelf = EXPLICIT_SELF_CONFIRMATION_RE.test(candidateText);
    const selfMatch = explicitSelf
      ? new RegExp(String.raw`^(?:yes[,!]?\s+|yeah[,!]?\s+|yep[,!]?\s+)?(?:i(?:'|’)?m|i am|my name is)\s+${NAME_CAPTURE}(?=$|[,.!?;])`, 'iu').exec(candidateText)
      : null;
    const explicitName = selfMatch ? validatedName(selfMatch[1]) : null;
    const explicitlyMatchesCustomer = Boolean(
      explicitName && normalizeName(explicitName) === normalizeName(pending.intro.customerName)
    );
    const adjacentIdentityAck = segmentOrdinal === pending.introOrdinal + 1 && ADJACENT_IDENTITY_ACK_RE.test(candidateText);
    pending.candidateConfirmedIdentity ||= explicitlyMatchesCustomer || adjacentIdentityAck;
    // Two turns from one canonical slot are necessary but not sufficient:
    // Deepgram can split the rep into a fresh raw index. Require the candidate
    // to affirm the introduced identity too, so two ordinary rep turns cannot
    // accidentally become the customer.
    if (pending.candidateTurns < 2 || !pending.candidateConfirmedIdentity) return { pendingCustomer: true };

    // If this slot already carries any authoritative/manual identity, do not
    // replace it with a name inferred from another person's utterance.
    if (locks.has(si)) {
      pending = null;
      return { conflict: { reason: 'customer_slot_already_locked', speakerIndex: Number(si) } };
    }

    const customerResult = await resolve(
      si,
      pending.intro.customerName,
      'customer',
      pending.intro,
      pending.introSegment,
      pending.intro.confidence,
      segment,
    );
    pending = null;
    return { customer: customerResult };
  }

  function addAlias(rawIndex, canonicalIndex) {
    const raw = canonical(rawIndex);
    const target = canonical(canonicalIndex);
    if (raw === target) return { aliased: false, reason: 'same' };
    // Introduction and manual locks are authoritative boundaries. A later
    // spectral merge may not collapse either side and undo attribution.
    if (locks.has(raw) || locks.has(target)) return { aliased: false, reason: 'locked' };
    aliases.set(raw, target);
    return { aliased: true };
  }

  function setManualLock(index, name) {
    const si = canonical(index);
    const currentSource = lockSources.get(si);
    if (currentSource === 'manual' && locks.get(si) === name) return;
    locks.set(si, name);
    lockSources.set(si, 'manual');
    if (pending?.repIndex === si || pending?.candidateIndex === si) pending = null;
  }

  return {
    enabled,
    onSegment,
    addAlias,
    setManualLock,
    getLock: (index) => locks.get(canonical(index)),
    getLockSource: (index) => lockSources.get(canonical(index)),
    canMerge: (rawIndex, canonicalIndex) => !locks.has(canonical(rawIndex)) && !locks.has(canonical(canonicalIndex)),
    _state: () => ({ pending, locks: new Map(locks), existingEvidence }),
  };
}

/**
 * Atomically persist one proven identity and relabel its prior generic rows.
 * The JSONB key guard makes first-writer/manual-lock precedence idempotent.
 */
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
       RETURNING speaker_labels, speaker_label_evidence`,
      [name, JSON.stringify(evidence), meetingId, speakerId, si],
    );
    if (meetingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { resolved: false, reason: 'persisted_lock_won', speakerId, relabeledCount: 0 };
    }
    const relabelResult = await client.query(
      `UPDATE transcript_segments SET speaker = $1
       WHERE meeting_id = $2 AND speaker = $3`,
      [name, meetingId, speakerId],
    );
    await client.query('COMMIT');
    return {
      resolved: true,
      speakerId,
      relabeledCount: relabelResult.rowCount || 0,
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

export const _internals = {
  normalizeName,
  accountMatchesSpokenName,
  EXPLICIT_SELF_CONFIRMATION_RE,
  ADJACENT_IDENTITY_ACK_RE,
};
