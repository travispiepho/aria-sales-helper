/**
 * introDetection.js — shared mid-call speaker-name intro detector.
 *
 * WHY THIS EXISTS (2026-08-18, third pass — see root-cause report)
 * -----------------------------------------------------------------
 * server.js's in-person `/meetings/:meetingId/audio` WS handler has its own
 * inline copy of this state machine (speakerFirstSeen / introCandidates /
 * maybeSuggestIntro / introSweepTimer / speakerLockController — see that
 * file's "Mid-call name-introduction" section). telephony.js's phone-call
 * handler (`/telephony/stream`) NEVER had ANY version of this logic — it
 * only inserted/broadcast transcript segments. That is the actual root
 * cause of "the popup never fires on real calls": essentially all of
 * Gabe's real dogfooding traffic in this build is `channel = 'phone'`
 * (Aria Phone Channel), and the entire intro-suggestion feature — collect
 * candidates, 15s window, sweep timer, confirm/reject route — simply did
 * not exist on that code path. Confirmed live against prod Neon data
 * 2026-08-18: multiple phone-channel meetings contain literal "I'm doing
 * well" / "I'm glad to hear that" style utterances that pass isLikelyName()
 * poorly (correctly rejected as non-names) plus, critically, the SAME
 * `Speaker N` auto-label (never renamed) that would result if a real
 * "I'm John" utterance were spoken on this path — because nothing in
 * telephony.js ever even looks for one. Railway runtime logs across the
 * available retention window contain ZERO "Speaker intro SUGGESTION" or
 * "speaker_lock_suggestion" log lines for any phone-channel call, despite
 * f13acf7's sweep-timer fix being deployed and correct for the code path it
 * touched (server.js only).
 *
 * This module extracts the DETECTION logic (not the transport/lifecycle —
 * that stays separate per-caller, same reasoning as dgReconnectPolicy.js's
 * header comment: telephony.js and server.js keep their own separate
 * WebSocket plumbing, only the shared reusable piece is unified here) so a
 * fourth code path never has to reinvent or, worse, forget this again.
 *
 * DESIGN — UNCHANGED FROM 4db9c11 / f13acf7, JUST FACTORED OUT
 * ---------------------------------------------------------------
 *   - 15s collection window per speaker slot (INTRO_WINDOW_MS).
 *   - Every candidate matching the intro regex + isLikelyName() is tallied;
 *     most-repeated wins after the window elapses.
 *   - A fixed-interval sweep (independent of new transcript arrivals) is
 *     what actually fires the elapsed check — this is the f13acf7 fix,
 *     preserved here since the same "customer says one line and goes quiet"
 *     shape applies equally (arguably more) to phone calls.
 *   - NEVER overrides an existing lock (voice-print or already-confirmed
 *     intro) — `speakerLocks` is checked first in maybeSuggestIntro().
 *   - Reject keeps listening: adds to rejectedIntroNames, applies a 20s
 *     cooldown (INTRO_SUGGEST_COOLDOWN_MS) before the same slot can
 *     re-suggest, does NOT give up on the slot for the rest of the call.
 *   - Human confirm commits the lock via speakerLockController.confirm(),
 *     called from POST /api/meetings/:id/speaker-lock exactly as it already
 *     is for the in-person path — no change to that route or to the web
 *     client's popup handling required.
 *
 * DIAGNOSTIC LOGGING (this pass's explicit deliverable)
 * ---------------------------------------------------------------
 * Every decision point below logs through the caller-supplied `log()`
 * function with a distinct, greppable prefix so a fourth failure is
 * diagnosable from Railway logs in minutes:
 *   - "intro candidate collected"   — a name passed isLikelyName() and was
 *                                     tallied for a slot.
 *   - "intro window elapsed, no candidates" — the 15s window closed for a
 *                                     slot but nothing was ever collected
 *                                     (nobody said anything intro-shaped, OR
 *                                     the regex/isLikelyName rejected
 *                                     everything said).
 *   - "intro suggestion emitted"    — the actual speaker_lock_suggestion
 *                                     broadcast fired.
 *   - "intro suggestion suppressed" — elapsed >= window but something else
 *                                     blocked emission (already locked,
 *                                     already pending, still in cooldown) —
 *                                     logs WHICH reason specifically.
 */

/**
 * @param {object} opts
 * @param {(msg: string) => void} opts.log
 * @param {(payload: object) => void} opts.broadcast — broadcastToMeeting(meetingId, payload)
 * @param {(raw: string) => boolean} opts.isLikelyName
 * @param {(raw: string) => string} opts.toDisplayName
 * @param {number} [opts.introWindowMs]
 * @param {number} [opts.suggestCooldownMs]
 */
export function createIntroDetector({
  log,
  broadcast,
  isLikelyName,
  toDisplayName,
  introWindowMs = 15000,
  suggestCooldownMs = 20000,
}) {
  const logFn = log || (() => {});
  const INTRO_RE = /\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Za-z][A-Za-z'’-]{1,20})\b/gi;

  const speakerLocks = {};             // si (string) -> displayName
  const speakerFirstSeen = {};         // si -> ms slot first observed
  const introCandidates = {};          // si -> Map(nameLower -> { name, count })
  const rejectedIntroNames = {};       // si -> Set(nameLower)
  const pendingIntroSuggestion = {};   // si -> nameLower currently awaiting a user answer
  const introSuggestCooldownUntil = {}; // si -> ms

  function maybeSuggestIntro(si, nowIntro) {
    if (speakerLocks[si]) {
      logFn(`intro suggestion suppressed: Speaker ${parseInt(si, 10) + 1} already locked to "${speakerLocks[si]}"`);
      return;
    }
    const firstSeen = speakerFirstSeen[si];
    if (firstSeen === undefined) return; // slot not observed yet — nothing to evaluate
    const elapsed = nowIntro - firstSeen;
    if (elapsed < introWindowMs) return; // window still open — not a decision point yet

    if (pendingIntroSuggestion[si]) {
      // Already awaiting a user answer for this slot — don't re-emit.
      return;
    }
    const cooldownOk = nowIntro >= (introSuggestCooldownUntil[si] || 0);
    if (!cooldownOk) {
      logFn(`intro suggestion suppressed: Speaker ${parseInt(si, 10) + 1} in cooldown until ${new Date(introSuggestCooldownUntil[si]).toISOString()}`);
      return;
    }

    const candidates = introCandidates[si];
    if (!candidates || candidates.size === 0) {
      logFn(`intro window elapsed, no candidates: Speaker ${parseInt(si, 10) + 1} (elapsed=${elapsed}ms, no isLikelyName() hits collected)`);
      return;
    }

    const best = [...candidates.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) return;

    pendingIntroSuggestion[si] = best.name.toLowerCase();
    introSuggestCooldownUntil[si] = nowIntro + suggestCooldownMs;
    logFn(`intro suggestion emitted: Speaker ${parseInt(si, 10) + 1} may be "${best.name}" (awaiting user confirm)`);
    broadcast({
      type: 'speaker_lock_suggestion',
      speakerId: `Speaker ${parseInt(si, 10) + 1}`,
      name: best.name,
    });
  }

  /**
   * Call once per final transcript segment with its canonical speaker index
   * (si, 0-based number or numeric string) and the segment's text. Collects
   * intro candidates and evaluates the elapsed-window check inline (in
   * addition to the sweep timer below) so a suggestion can fire immediately
   * if the window already elapsed by the time this segment arrives.
   */
  function onFinalSegment(rawSi, text) {
    const si = String(rawSi);
    const nowIntro = Date.now();
    if (speakerFirstSeen[si] === undefined) speakerFirstSeen[si] = nowIntro;

    if (!speakerLocks[si]) {
      let m;
      INTRO_RE.lastIndex = 0;
      while ((m = INTRO_RE.exec(text)) !== null) {
        const raw = m[1];
        if (!isLikelyName(raw)) continue;
        const display = toDisplayName(raw);
        const nameLower = display.toLowerCase();
        if (rejectedIntroNames[si] && rejectedIntroNames[si].has(nameLower)) continue;
        if (!introCandidates[si]) introCandidates[si] = new Map();
        const prev = introCandidates[si].get(nameLower);
        introCandidates[si].set(nameLower, { name: display, count: (prev ? prev.count : 0) + 1 });
        logFn(`intro candidate collected: Speaker ${parseInt(si, 10) + 1} -> "${display}" (count=${introCandidates[si].get(nameLower).count})`);
      }
      maybeSuggestIntro(si, nowIntro);
    }
  }

  /**
   * Fixed-interval sweep — the f13acf7 fix, preserved here. Evaluates the
   * elapsed-window check for every known speaker slot independent of new
   * transcript arrivals, because a real caller (customer OR rep) very often
   * introduces themselves once and then goes quiet for the rest of the
   * call, and that slot's own elapsed check would otherwise never
   * re-evaluate.
   */
  function sweep() {
    const nowSweep = Date.now();
    for (const si of Object.keys(speakerFirstSeen)) {
      maybeSuggestIntro(si, nowSweep);
    }
  }

  function _siFromLabel(speakerId) {
    const m = /Speaker\s+(\d+)/i.exec(String(speakerId || ''));
    if (!m) return null;
    return String(parseInt(m[1], 10) - 1);
  }

  const speakerLockController = {
    confirm(speakerId, name) {
      const si = _siFromLabel(speakerId);
      if (si === null) return { ok: false, error: 'bad speakerId' };
      const display = toDisplayName(name) || String(name || '').trim();
      if (!display) return { ok: false, error: 'empty name' };
      if (!speakerLocks[si]) {
        speakerLocks[si] = display;
        logFn(`intro CONFIRMED by user: Speaker ${parseInt(si, 10) + 1} -> ${display}`);
      }
      delete pendingIntroSuggestion[si];
      broadcast({
        type: 'speaker_lock',
        speakerId: `Speaker ${parseInt(si, 10) + 1}`,
        name: speakerLocks[si],
      });
      return { ok: true, locked: speakerLocks[si] };
    },
    reject(speakerId, name) {
      const si = _siFromLabel(speakerId);
      if (si === null) return { ok: false, error: 'bad speakerId' };
      const nameLower = String(name || '').trim().toLowerCase();
      if (nameLower) {
        if (!rejectedIntroNames[si]) rejectedIntroNames[si] = new Set();
        rejectedIntroNames[si].add(nameLower);
        if (introCandidates[si]) introCandidates[si].delete(nameLower);
      }
      delete pendingIntroSuggestion[si];
      introSuggestCooldownUntil[si] = Date.now() + suggestCooldownMs;
      logFn(`intro REJECTED by user: Speaker ${parseInt(si, 10) + 1} not "${name}" — still listening`);
      broadcast({
        type: 'speaker_lock_suggestion_dismiss',
        speakerId: `Speaker ${parseInt(si, 10) + 1}`,
      });
      return { ok: true };
    },
    // Allow an external lock source (e.g. a future voice-print match on the
    // phone path) to pre-seed speakerLocks so this detector correctly stays
    // silent for that slot (maybeSuggestIntro's first check). Not currently
    // called by telephony.js (no voice-print integration on this path yet)
    // — provided for parity/future use, mirrors the invariant already
    // documented above.
    externalLock(speakerId, name) {
      const si = _siFromLabel(speakerId);
      if (si === null) return;
      speakerLocks[si] = name;
    },
    // Read-only lookup of a speaker slot's CONFIRMED display name (voice-
    // print lock via externalLock(), or a human-confirmed intro via
    // confirm()) — returns undefined if that slot has no resolved
    // attribution yet. Added for the live rebuttal teleprompter (2026-08-18
    // 2nd pass): telephony.js's phone-call path has no equivalent of
    // server.js's own inline `speakerLocks` object to read from, so this
    // getter lets a caller ask "do we actually know who Speaker N is yet?"
    // without duplicating the si-parsing/lock-storage logic. Does not
    // affect existing on-the-wire behavior at all — purely additive.
    getLockedName(speakerId) {
      const si = _siFromLabel(speakerId);
      if (si === null) return undefined;
      return speakerLocks[si];
    },
  };

  return { onFinalSegment, sweep, speakerLockController };
}
