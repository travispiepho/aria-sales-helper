/**
 * speakerRelabel.js — provisional-speaker-slot → resolved-identity state
 * machine, plus backward relabeling of already-emitted transcript lines.
 *
 * This is PURE application logic with zero vendor dependency. Per
 * memory/voice-fingerprinting-comparison-2026-08-03.md: no diarization/
 * voiceprint vendor (pyannoteAI included) auto-relabels prior transcript
 * lines once a provisional speaker slot resolves to a real identity — that
 * remapping is entirely our own responsibility, regardless of which vendor
 * we're on. This module is buildable and testable today, independent of
 * whether PYANNOTE_API_KEY exists.
 *
 * Model:
 *   - A "session" tracks N provisional speaker slots (e.g. Deepgram's or
 *     pyannoteAI's SPEAKER_00, SPEAKER_01, ...).
 *   - Each transcript line is appended tagged with whichever slot produced
 *     it at the time.
 *   - When a slot resolves to a real name/identity (via voice-print match,
 *     mid-call self-introduction, or an explicit vendor /identify result),
 *     call `resolveSpeaker()`. All PRIOR lines tagged with that slot are
 *     relabeled in place (mutated) to the resolved name, and the session
 *     remembers the resolution so all FUTURE lines for that slot use the
 *     resolved name directly.
 *   - A slot can only be resolved once per session (first resolution wins);
 *     subsequent resolve calls for an already-resolved slot are no-ops
 *     unless `force: true` is passed (used by drift-correction flows).
 *
 * This mirrors (in a vendor-agnostic, extracted, testable form) the same
 * relabel shape already implemented ad hoc inline in server.js's
 * /meetings/:meetingId/audio WS handler (the `speakerLocks` object + the
 * `UPDATE transcript_segments SET speaker = ... WHERE speaker = ...` calls).
 * server.js's existing in-person pipeline is NOT modified to use this module
 * (out of scope / too risky to touch working code per task instructions) —
 * this module exists so the Aria Phone Channel (Twilio) pipeline, and any
 * future pyannoteAI-backed pipeline, has a single well-tested implementation
 * to call instead of re-deriving the same logic ad hoc a second time.
 */

/**
 * Create a new relabel session.
 * @returns {object} session handle — pass to every other function below.
 */
export function createSpeakerSession() {
  return {
    // provisional slot id (string) -> resolved display name
    resolved: new Map(),
    // provisional slot id (string) -> array of line objects appended under
    // that slot BEFORE resolution (kept so we can mutate them on resolve)
    linesBySlot: new Map(),
    // full ordered transcript, each line: { slot, speaker, text, ...meta }
    transcript: [],
  };
}

/**
 * Append a new transcript line under a provisional (or already-resolved)
 * speaker slot. Returns the line object that was pushed (same reference is
 * mutated in place if/when the slot later resolves).
 *
 * @param {object} session
 * @param {string|number} slot - provisional speaker slot id (e.g. "SPEAKER_00" or 0)
 * @param {string} text
 * @param {object} [meta] - arbitrary extra fields to carry on the line (ts, wordCount, etc.)
 */
export function appendLine(session, slot, text, meta = {}) {
  const slotKey = String(slot);
  const speaker = session.resolved.get(slotKey) || `Speaker ${slotKey}`;
  const line = { slot: slotKey, speaker, text, ...meta };
  session.transcript.push(line);

  // Track EVERY line ever tagged under this raw slot, not just ones emitted
  // before the first resolution. This is what allows a later force-resolve
  // (drift correction: "the earlier lock was wrong") to walk back and fix
  // lines that were emitted under the (now known-incorrect) first identity
  // too — not just the pre-resolution generic-labeled ones. Without this,
  // a force-correction would only fix the earliest lines and silently leave
  // everything said between the bad lock and the correction mislabeled.
  if (!session.linesBySlot.has(slotKey)) session.linesBySlot.set(slotKey, []);
  session.linesBySlot.get(slotKey).push(line);

  return line;
}

/**
 * Resolve a provisional slot to a real identity. Mutates every prior line
 * tagged with that slot to carry the resolved name (backward relabel), and
 * remembers the resolution so future appendLine() calls for that slot use
 * the name directly.
 *
 * @param {object} session
 * @param {string|number} slot
 * @param {string} name - resolved display name (e.g. "John Smith")
 * @param {object} [opts]
 * @param {boolean} [opts.force] - allow re-resolving an already-resolved slot
 *   (e.g. drift-correction: the earlier lock turns out to be wrong). Distinct
 *   from the multi-sample voiceprint story — this is about correcting a
 *   session-level assignment, not about how many enrollment samples exist.
 * @returns {{ resolved: boolean, relabeledCount: number, previousName?: string }}
 */
export function resolveSpeaker(session, slot, name, opts = {}) {
  const slotKey = String(slot);
  const alreadyResolved = session.resolved.has(slotKey);

  if (alreadyResolved && !opts.force) {
    return { resolved: false, relabeledCount: 0, previousName: session.resolved.get(slotKey) };
  }

  const previousName = alreadyResolved ? session.resolved.get(slotKey) : undefined;
  session.resolved.set(slotKey, name);

  // Walk back EVERY line ever tagged under this raw slot (both lines from
  // before this resolution AND, on a force-correction, lines emitted under
  // a prior incorrect resolution) and relabel them all to the new name.
  const allLinesForSlot = session.linesBySlot.get(slotKey) || [];
  let relabeledCount = 0;
  for (const line of allLinesForSlot) {
    if (line.speaker !== name) {
      line.speaker = name;
      relabeledCount++;
    }
  }

  return { resolved: true, relabeledCount, previousName };
}

/** Whether a given slot has already resolved to a real identity. */
export function isResolved(session, slot) {
  return session.resolved.has(String(slot));
}

/** Get the current display name for a slot (resolved name, or a generic placeholder). */
export function getDisplayName(session, slot) {
  const slotKey = String(slot);
  return session.resolved.get(slotKey) || `Speaker ${slotKey}`;
}

/** Return the full transcript array (line objects reflect current/relabeled state). */
export function getTranscript(session) {
  return session.transcript;
}

/**
 * Build the SQL parameters for a backward-relabel DB update, given a
 * resolution result. Callers own the actual `pool.query` call (this module
 * has no DB dependency) — this just centralizes the "what changed" shape so
 * server.js/telephony.js don't have to re-derive it.
 *
 * Example use (illustrative, not executed here):
 *   const r = resolveSpeaker(session, slot, name);
 *   if (r.resolved && r.relabeledCount > 0) {
 *     await pool.query(
 *       `UPDATE transcript_segments SET speaker = $1 WHERE meeting_id = $2 AND speaker = $3`,
 *       [name, meetingId, `Speaker ${slot}`]
 *     );
 *   }
 */
export function describeResolution(slot, name, result) {
  return {
    slot: String(slot),
    resolvedTo: name,
    relabeledCount: result.relabeledCount,
    previousName: result.previousName ?? null,
  };
}
