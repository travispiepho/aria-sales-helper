import { createHash } from 'node:crypto';

export const FIRST30_REPAIR_WINDOW_MS = 30_000;
export const PCM_BYTES_PER_SECOND = 32_000;
const ELIGIBLE_CHANNELS = new Set(['in_person', 'uploaded_recording']);
const TERMINAL_STATUSES = new Set(['applied', 'no_op']);

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/’/g, "'").replace(/[^\p{L}\p{M}'-]+/gu, ' ').trim();
}

function nameParts(value) {
  return normalize(value).split(/\s+/u).filter((part) => part.length > 1);
}

function containsName(text, name) {
  const normalized = ` ${normalize(text)} `;
  return nameParts(name).some((part) => normalized.includes(` ${part} `));
}

function selfIntroduces(text, name) {
  const parts = nameParts(name);
  if (parts.length === 0) return false;
  const normalized = normalize(text);
  return parts.some((part) => new RegExp(`\\b(?:i am|i'm|im|my name is|this is)\\s+${part}\\b`, 'iu').test(normalized));
}

export function classifyContextualRole(text, { repName, customerName } = {}) {
  if (!repName || !customerName || normalize(repName) === normalize(customerName)) return null;
  const input = String(text || '').normalize('NFKC').trim();
  if (!input) return null;
  const normalized = normalize(input);

  const repSelf = selfIntroduces(input, repName);
  const customerSelf = selfIntroduces(input, customerName);
  if (repSelf !== customerSelf) return { role: repSelf ? 'rep' : 'customer', rule: repSelf ? 'rep_self_introduction' : 'customer_self_introduction' };

  const addressesCustomerThenRep = containsName(input, customerName) && containsName(input, repName)
    && /\b(?:this is|i am|i'm|im|my name is)\b/iu.test(normalized);
  if (addressesCustomerThenRep && repSelf) return { role: 'rep', rule: 'known_name_introduction' };

  const repRoleCues = [
    /\bcertapro\b/iu,
    /\b(?:i(?:'ll| will)|let me|i can)\s+(?:walk|show|measure|take|prepare|put|look|explain|write|send|inspect)\b/iu,
    /\b(?:our|the)\s+(?:estimate|painting|proposal|sales)\s+(?:process|appointment|system|team)\b/iu,
    /\bwhat\s+(?:rooms?|areas?|surfaces?|colors?|work)\s+(?:do|would|are)\s+you\b/iu,
    /\bwhat\s+(?:brings|prompted)\s+you\b/iu,
  ];
  const customerRoleCues = [
    /\b(?:thanks|thank you)\s+for\s+(?:coming|meeting|your time|being here)\b/iu,
    /\b(?:i|we)\s+(?:need|want|would like|are looking|were looking|hope|are hoping|were hoping|have been trying)\b/iu,
    /\b(?:my|our)\s+(?:home|house|room|rooms|kitchen|bedroom|bathroom|walls?|ceiling|trim|exterior|interior|garage|deck|property)\b/iu,
    /\b(?:we've|we have|i've|i have)\s+(?:lived|owned|noticed|been)\b/iu,
  ];
  const repCue = repRoleCues.some((pattern) => pattern.test(normalized));
  const customerCue = customerRoleCues.some((pattern) => pattern.test(normalized));
  if (repCue !== customerCue) return { role: repCue ? 'rep' : 'customer', rule: repCue ? 'rep_role_cue' : 'customer_first_person_cue' };
  return null;
}

function questionLike(text) {
  return /\?\s*$/u.test(String(text || '').trim()) || /^(?:what|which|when|where|why|how|do|does|did|are|is|would|could|can|have|has)\b/iu.test(String(text || '').trim());
}

function answerLike(text) {
  return /^(?:yes|yeah|yep|no|nope|sure|right|correct|well|we|i|my|our)\b/iu.test(String(text || '').trim());
}

function manualLockForSegment(meeting, segment) {
  if (!Number.isInteger(segment.speaker_slot)) return null;
  const key = `Speaker ${segment.speaker_slot + 1}`;
  const label = meeting?.speaker_labels?.[key];
  if (!label) return null;
  const evidence = meeting?.speaker_label_evidence?.[String(segment.speaker_slot)];
  if (evidence?.method === 'introduction' || evidence?.method === 'first30_contextual_repair') return null;
  return String(label).trim() || null;
}

function transcriptFingerprint(segments) {
  const hash = createHash('sha256');
  for (const segment of segments) {
    hash.update(String(segment.id));
    hash.update('\0');
    hash.update(String(segment.text || ''));
    hash.update('\0');
    hash.update(String(segment.media_start_ms ?? ''));
    hash.update('\0');
    hash.update(String(segment.media_end_ms ?? ''));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function analyzeFirst30SpeakerRepair({ meeting, segments, repName, customerName }) {
  if (!ELIGIBLE_CHANNELS.has(meeting?.channel) || meeting?.call_sid) return { status: 'no_op', reason: 'excluded_channel', corrections: [], slotLabels: {} };
  if (!repName || !customerName || normalize(repName) === normalize(customerName)) return { status: 'no_op', reason: 'missing_distinct_known_identities', corrections: [], slotLabels: {} };

  const windowSegments = [...(segments || [])]
    .filter((segment) => Number.isFinite(Number(segment.media_start_ms)) && Number(segment.media_start_ms) < FIRST30_REPAIR_WINDOW_MS)
    .sort((a, b) => Number(a.media_start_ms) - Number(b.media_start_ms) || String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  if (windowSegments.length < 2) return { status: 'no_op', reason: 'insufficient_window_segments', corrections: [], slotLabels: {}, transcriptFingerprint: transcriptFingerprint(windowSegments) };

  const decisions = windowSegments.map((segment) => classifyContextualRole(segment.text, { repName, customerName }));
  // Deterministic Q/A propagation is deliberately one-hop and requires an
  // already-explicit role cue. It never alternates an otherwise ambiguous run.
  for (let index = 0; index < decisions.length; index += 1) {
    if (decisions[index]) continue;
    const next = decisions[index + 1];
    if (questionLike(windowSegments[index].text) && next?.role === 'customer') {
      decisions[index] = { role: 'rep', rule: 'question_before_customer_answer' };
      continue;
    }
    const previous = decisions[index - 1];
    if (previous?.role === 'rep' && questionLike(windowSegments[index - 1].text) && answerLike(windowSegments[index].text)) {
      decisions[index] = { role: 'customer', rule: 'answer_after_rep_question' };
    }
  }

  const roles = new Set(decisions.filter(Boolean).map(({ role }) => role));
  if (!roles.has('rep') || !roles.has('customer')) {
    return { status: 'no_op', reason: 'ambiguous_context', corrections: [], slotLabels: {}, transcriptFingerprint: transcriptFingerprint(windowSegments) };
  }

  const roleName = { rep: String(repName).trim(), customer: String(customerName).trim() };
  const corrections = [];
  const slotRoles = new Map();
  for (let index = 0; index < windowSegments.length; index += 1) {
    const decision = decisions[index];
    if (!decision) continue;
    const segment = windowSegments[index];
    const target = roleName[decision.role];
    const manual = manualLockForSegment(meeting, segment);
    if (manual && normalize(manual) !== normalize(target)) continue;
    if (Number.isInteger(segment.speaker_slot)) {
      if (!slotRoles.has(segment.speaker_slot)) slotRoles.set(segment.speaker_slot, new Set());
      slotRoles.get(segment.speaker_slot).add(decision.role);
    }
    if (normalize(segment.speaker) !== normalize(target)) {
      corrections.push({
        id: segment.id,
        from: segment.speaker,
        speaker: target,
        role: decision.role,
        rule: decision.rule,
        media_start_ms: Number(segment.media_start_ms),
        media_end_ms: Number(segment.media_end_ms),
      });
    }
  }

  const slotLabels = {};
  for (const [slot, assignedRoles] of slotRoles) {
    if (assignedRoles.size !== 1) continue;
    const role = [...assignedRoles][0];
    const key = `Speaker ${slot + 1}`;
    const current = meeting?.speaker_labels?.[key];
    const evidence = meeting?.speaker_label_evidence?.[String(slot)];
    const manual = current && !['introduction', 'first30_contextual_repair'].includes(evidence?.method);
    if (!manual || normalize(current) === normalize(roleName[role])) slotLabels[String(slot)] = { speakerId: key, name: roleName[role], role };
  }

  return {
    status: corrections.length > 0 || Object.keys(slotLabels).length > 0 ? 'applied' : 'no_op',
    reason: corrections.length > 0 || Object.keys(slotLabels).length > 0 ? 'contextual_roles_resolved' : 'already_consistent_or_manual_protected',
    corrections,
    slotLabels,
    lastResolvedRole: [...decisions].reverse().find(Boolean)?.role || null,
    transcriptFingerprint: transcriptFingerprint(windowSegments),
  };
}

export async function persistFirst30SpeakerRepair({ pool, meetingId, repName, customerName, observedMediaMs }) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const meetingResult = await client.query('SELECT * FROM meetings WHERE id = $1 FOR UPDATE', [meetingId]);
    const meeting = meetingResult.rows[0];
    if (!meeting) {
      await client.query('ROLLBACK');
      return { attempted: false, reason: 'meeting_not_found' };
    }
    const priorState = meeting.first30_speaker_repair || {};
    if (TERMINAL_STATUSES.has(priorState.status)) {
      await client.query('ROLLBACK');
      return { attempted: false, reason: 'already_attempted', state: priorState, corrections: [], slotLabels: priorState.slot_labels || {} };
    }
    const mediaMs = Math.max(Number(meeting.media_time_ms) || 0, Number(observedMediaMs) || 0);
    if (mediaMs < FIRST30_REPAIR_WINDOW_MS) {
      await client.query('ROLLBACK');
      return { attempted: false, reason: 'threshold_not_reached' };
    }
    const segmentResult = await client.query(
      `SELECT id, meeting_id, ts, speaker, text, word_count, duration_ms, media_start_ms, media_end_ms, speaker_slot
       FROM transcript_segments
       WHERE meeting_id = $1 AND media_start_ms < $2
       ORDER BY media_start_ms ASC, ts ASC, id ASC
       FOR UPDATE`,
      [meetingId, FIRST30_REPAIR_WINDOW_MS],
    );
    const plan = analyzeFirst30SpeakerRepair({ meeting, segments: segmentResult.rows, repName, customerName });

    for (const correction of plan.corrections) {
      const changed = await client.query(
        `UPDATE transcript_segments SET speaker = $1
         WHERE id = $2 AND meeting_id = $3 AND speaker IS NOT DISTINCT FROM $4`,
        [correction.speaker, correction.id, meetingId, correction.from],
      );
      if (changed.rowCount !== 1) throw new Error('first30 repair lost a transcript row write race');
    }

    const labelsPatch = {};
    const evidencePatch = {};
    for (const [slot, label] of Object.entries(plan.slotLabels)) {
      labelsPatch[label.speakerId] = label.name;
      evidencePatch[slot] = { method: 'first30_contextual_repair', role: label.role, version: 1 };
    }
    const state = {
      version: 1,
      status: plan.status,
      reason: plan.reason,
      attempted_at: new Date().toISOString(),
      window_ms: FIRST30_REPAIR_WINDOW_MS,
      observed_media_ms: Math.floor(mediaMs),
      transcript_fingerprint_sha256: plan.transcriptFingerprint,
      corrections: plan.corrections.map(({ id, from, speaker, role, rule, media_start_ms, media_end_ms }) => ({ id, from, speaker, role, rule, media_start_ms, media_end_ms })),
      slot_labels: plan.slotLabels,
      last_resolved_role: plan.lastResolvedRole,
    };
    const update = await client.query(
      `UPDATE meetings
       SET media_time_ms = GREATEST(COALESCE(media_time_ms, 0), $2),
           first30_speaker_repair = $3::jsonb,
           speaker_labels = COALESCE(speaker_labels, '{}'::jsonb) || $4::jsonb,
           speaker_label_evidence = COALESCE(speaker_label_evidence, '{}'::jsonb) || $5::jsonb
       WHERE id = $1
       RETURNING speaker_labels, speaker_label_evidence, first30_speaker_repair`,
      [meetingId, Math.floor(mediaMs), JSON.stringify(state), JSON.stringify(labelsPatch), JSON.stringify(evidencePatch)],
    );
    await client.query('COMMIT');
    return {
      attempted: true,
      status: plan.status,
      reason: plan.reason,
      corrections: plan.corrections,
      slotLabels: plan.slotLabels,
      state: update.rows[0]?.first30_speaker_repair || state,
      speakerLabels: update.rows[0]?.speaker_labels || { ...(meeting.speaker_labels || {}), ...labelsPatch },
      speakerLabelEvidence: update.rows[0]?.speaker_label_evidence || { ...(meeting.speaker_label_evidence || {}), ...evidencePatch },
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release?.();
  }
}

export function knownCustomerNameFromMeeting(meeting) {
  for (const [slot, evidence] of Object.entries(meeting?.speaker_label_evidence || {})) {
    if (!['introduction', 'first30_contextual_repair'].includes(evidence?.method)) continue;
    const inferred = evidence?.role === 'customer'
      ? meeting?.speaker_labels?.[`Speaker ${Number(slot) + 1}`] || evidence?.resolved_name || evidence?.customer_name
      : evidence?.customer_candidate;
    if (String(inferred || '').trim()) return String(inferred).trim();
  }
  return String(meeting?.customer_name || '').trim() || null;
}

export function createFirst30SpeakerRepairCoordinator({
  pool, meeting, meetingId = meeting?.id, repName, customerName, broadcastToMeeting = () => {}, onSlotLabels = () => {}, logger = () => {},
}) {
  const enabled = ELIGIBLE_CHANNELS.has(meeting?.channel) && !meeting?.call_sid;
  const initialMediaMs = Math.max(0, Number(meeting?.media_time_ms) || 0);
  let knownRepName = String(repName || '').trim() || null;
  let knownCustomerName = String(customerName || knownCustomerNameFromMeeting(meeting) || '').trim() || null;
  // Only audio accepted by the transcription provider advances media time.
  // Bytes can arrive while that provider is disconnected and be queued for
  // later; counting them on receipt would also count them again on replay.
  let acceptedMediaBytes = Math.floor(initialMediaMs * PCM_BYTES_PER_SECOND / 1000);
  let lastPersistedMs = initialMediaMs;
  let terminal = TERMINAL_STATUSES.has(meeting?.first30_speaker_repair?.status);
  let queue = Promise.resolve();
  const learnedSlotLabels = { ...(meeting?.first30_speaker_repair?.slot_labels || {}) };

  const mediaMs = () => Math.floor(acceptedMediaBytes * 1000 / PCM_BYTES_PER_SECOND);
  const persistMedia = () => {
    if (!enabled || mediaMs() <= lastPersistedMs) return Promise.resolve();
    const value = mediaMs();
    lastPersistedMs = value;
    return pool.query(
      'UPDATE meetings SET media_time_ms = GREATEST(COALESCE(media_time_ms, 0), $2) WHERE id = $1',
      [meetingId, value],
    ).catch((error) => logger(`first30 media cursor persistence failed: ${error.message}`));
  };

  async function attempt() {
    if (!enabled || terminal || mediaMs() < FIRST30_REPAIR_WINDOW_MS) return { attempted: false, reason: !enabled ? 'excluded_channel' : terminal ? 'already_attempted' : 'threshold_not_reached' };
    await persistMedia();
    const result = await persistFirst30SpeakerRepair({
      pool, meetingId, repName: knownRepName, customerName: knownCustomerName, observedMediaMs: mediaMs(),
    });
    if (result.attempted || result.reason === 'already_attempted') terminal = true;
    if (result.slotLabels) {
      Object.assign(learnedSlotLabels, result.slotLabels);
      onSlotLabels(result.slotLabels, result);
    }
    if (result.attempted) {
      broadcastToMeeting(meetingId, {
        type: 'speaker_repair',
        windowMs: FIRST30_REPAIR_WINDOW_MS,
        corrections: result.corrections.map(({ id, speaker }) => ({ id, speaker })),
        speakerLabels: result.speakerLabels,
        status: result.status,
      });
    }
    return result;
  }

  return {
    enabled,
    initialMediaMs,
    currentMediaMs: mediaMs,
    noteAcceptedMediaBytes(byteLength) {
      if (!enabled || !Number.isFinite(byteLength) || byteLength <= 0) return;
      const wasBelowThreshold = mediaMs() < FIRST30_REPAIR_WINDOW_MS;
      acceptedMediaBytes += Math.floor(byteLength);
      if (mediaMs() - lastPersistedMs >= 1_000) {
        queue = queue.then(persistMedia);
      }
      // The 30-second boundary can be crossed during silence, after the last
      // finalized transcript row. Trigger from accepted media as well as from
      // row persistence so the repair does not wait for a 31st-second utterance.
      if (wasBelowThreshold && mediaMs() >= FIRST30_REPAIR_WINDOW_MS) {
        queue = queue.then(attempt);
      }
    },
    mediaOffsetMs(providerSeconds) {
      return initialMediaMs + Math.max(0, Math.round((Number(providerSeconds) || 0) * 1000));
    },
    afterSegmentPersisted() {
      queue = queue.then(attempt);
      return queue;
    },
    flush() { return persistMedia(); },
    labelForSegment({ speakerIndex, text, defaultLabel }) {
      const learned = learnedSlotLabels[String(speakerIndex)];
      if (learned?.name) return learned.name;
      if (!terminal) return defaultLabel;
      const decision = classifyContextualRole(text, { repName: knownRepName, customerName: knownCustomerName });
      return decision ? (decision.role === 'rep' ? knownRepName : knownCustomerName) : defaultLabel;
    },
    setKnownIdentity(role, name) {
      const display = String(name || '').trim();
      if (!display) return;
      if (role === 'rep') knownRepName = display;
      if (role === 'customer') knownCustomerName = display;
    },
    _attempt: attempt,
  };
}

export const _internals = { normalize, manualLockForSegment, transcriptFingerprint, questionLike, answerLike };
