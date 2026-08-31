/**
 * CoachingPanel.tsx — Phase 3: Real-Time Coaching Overlay
 * Displays DISC style, sales stage, checklist, nudges, and urgent alerts.
 * Mobile-first, always-visible (no collapse), Tailwind-only. The panel
 * always fills the full height of whatever container it's given (see
 * MeetingPage.tsx / UploadedRecordingPage.tsx feedback-column wiring) so it
 * never visually shrinks just because a section is showing a "Waiting on
 * data..." placeholder instead of real content.
 */

import React, { useState, useEffect, useRef } from 'react';
import { listCoachingStages } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoachingDisc {
  detected: 'D' | 'I' | 'S' | 'C' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  emoji: string;
  label: string;
  tip: string;
}

export interface CoachingStage {
  current: string;
  label: string;
}

export interface CoachingChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface CoachingData {
  disc?: CoachingDisc | null;
  stage?: CoachingStage | null;
  checklist?: CoachingChecklistItem[] | null;
  nudges?: string[] | null;
  urgent?: string | null;
}

interface CoachingPanelProps {
  coaching?: CoachingData | null;
}

// ─── Stage progress order ─────────────────────────────────────────────────────

// 2026-08-30 (aria_coaching_stages_admin_tab): this list used to be a
// hardcoded array here. It's now sourced from GET /api/coaching-stages
// (backed by the new coaching_stages table, admin-editable on the new
// /coaching page) so an admin's add/remove changes actually take effect
// for stageIndex/progress-percentage math below, not just cosmetically on
// the admin page. FALLBACK_STAGE_ORDER is the exact same 11 keys/order
// this component always used, kept as a same-render safety net for the
// brief window before the one-time fetch below resolves (or if it ever
// fails) -- so a rep never sees stage progress silently break/flash 0%
// just because this fetch hasn't landed yet.

const FALLBACK_STAGE_ORDER = [
  'setup_call',
  'arrival',
  'upfront_4',
  'first_go_around',
  'client_manual',
  'second_go_around',
  'rough_estimate',
  'prepare_proposal',
  'proposal_presentation',
  'ask_for_order',
  'follow_up',
];

// Fetch-once, cache-forever module-level singleton (this list only ever
// changes via an admin explicitly editing it on /coaching -- a full page
// reload is an acceptable/expected way to pick up that rare change,
// matching how other mostly-static reference data in this app is treated).
// Never throws: a failed fetch resolves to FALLBACK_STAGE_ORDER rather than
// rejecting, so callers don't need their own try/catch.
let stageOrderPromise: Promise<string[]> | null = null;
function getStageOrder(): Promise<string[]> {
  if (!stageOrderPromise) {
    // Wrapped in Promise.resolve().then(...) rather than calling
    // listCoachingStages() directly: some pre-existing test suites mock
    // '../lib/api' wholesale (without spreading importOriginal), so in
    // that environment listCoachingStages can be undefined and calling it
    // throws SYNCHRONOUSLY, before any Promise/.catch exists to swallow
    // it. Deferring the call into a microtask means a missing/throwing
    // mock rejects the promise instead of throwing outside of it, so the
    // existing .catch(() => FALLBACK_STAGE_ORDER) below still catches it
    // and this component never crashes a host page/test over stage-list
    // fetch failures.
    stageOrderPromise = Promise.resolve()
      .then(() => listCoachingStages())
      .then(({ stages }) => {
        const keys = stages.map((s) => s.key);
        return keys.length > 0 ? keys : FALLBACK_STAGE_ORDER;
      })
      .catch(() => FALLBACK_STAGE_ORDER);
  }
  return stageOrderPromise;
}

// Hook: starts with FALLBACK_STAGE_ORDER (so first render's progress math
// is never blank/zero) and swaps in the fetched list once it resolves.
function useStageOrder(): string[] {
  const [order, setOrder] = useState<string[]>(FALLBACK_STAGE_ORDER);
  useEffect(() => {
    let cancelled = false;
    getStageOrder().then((keys) => {
      if (!cancelled) setOrder(keys);
    });
    return () => { cancelled = true; };
  }, []);
  return order;
}

// ─── Confidence colors ────────────────────────────────────────────────────────

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-gray-100 text-gray-600',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function CoachingPanel({ coaching }: CoachingPanelProps) {
  const stageOrder = useStageOrder();
  const [nudgeIndex, setNudgeIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Never show blank — holds the last nudge that was actually rendered
  const lastValidNudgeRef = useRef<string>('');

  // Normalize every independently-arriving section. The server can produce a
  // partial first coaching pass, so one populated section must never make the
  // others render blank or disappear.
  const disc = coaching?.disc ?? null;
  const stage = coaching?.stage ?? null;
  const checklist = Array.isArray(coaching?.checklist) ? coaching.checklist : [];
  const allNudges = Array.isArray(coaching?.nudges)
    ? coaching.nudges.filter((nudge): nudge is string => typeof nudge === 'string' && nudge.trim().length > 0)
    : [];
  const urgent = typeof coaching?.urgent === 'string' ? coaching.urgent.trim() : '';

  const hasDisc = !!disc && !!(
    disc.emoji?.trim()
    || disc.label?.trim()
    || disc.tip?.trim()
    || (disc.detected && disc.detected !== 'unknown')
  );
  const hasStage = !!stage && !!(stage.label?.trim() || stage.current?.trim());

  // Troy's ask (aria_coaching_left_panel_space_between_layout): once the
  // panel has ANY real coaching data, its sections switch from a fixed
  // vertical gap to a top/bottom-anchored, evenly-distributed layout
  // (`justify-between`). The explicit exception is the fully-empty "Waiting
  // on data..." state (nothing has arrived yet at all) — that state's
  // layout is left byte-for-byte as it was before this change. A PARTIAL
  // coaching pass (some sections populated, others still individually
  // showing their own "Waiting on data..." placeholder) still counts as
  // "has data" here and gets the new layout — only the all-empty case is
  // carved out.
  const hasAnyCoachingData = hasDisc || hasStage || checklist.length > 0 || allNudges.length > 0 || !!urgent;

  // Clamp index so it's never out of bounds even mid-render
  const safeIndex = allNudges.length > 0 ? nudgeIndex % allNudges.length : 0;
  const currentNudge = allNudges[safeIndex];
  // Keep last valid nudge alive so we never flash blank
  if (currentNudge) lastValidNudgeRef.current = currentNudge;
  const displayNudge = currentNudge || lastValidNudgeRef.current;

  // Cycle nudges every 10 seconds unless paused
  useEffect(() => {
    if (allNudges.length <= 1 || paused) return;
    const timer = setInterval(() => {
      // Fade out → update → fade in
      setVisible(false);
      setTimeout(() => {
        setNudgeIndex(i => (i + 1) % allNudges.length);
        setVisible(true);
      }, 300);
    }, 10000);
    return () => clearInterval(timer);
  }, [allNudges.length, paused]);

  // When a new coaching pass arrives, keep current nudge showing — don't reset index
  // (safeIndex clamping handles any out-of-bounds; avoid jarring jumps mid-cycle)

  function handleNudgeTap() {
    // Tap to pause for 20s, then resume
    setPaused(true);
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = setTimeout(() => setPaused(false), 20000);
  }

  function goToNudge(i: number) {
    setVisible(false);
    setTimeout(() => {
      setNudgeIndex(i);
      setVisible(true);
    }, 200);
    setPaused(true);
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = setTimeout(() => setPaused(false), 20000);
  }

  const stageIndex = stage?.current ? stageOrder.indexOf(stage.current) : -1;
  const stageProgress = stageIndex >= 0 ? Math.round(((stageIndex + 1) / stageOrder.length) * 100) : 0;

  const doneCount = checklist.filter(item => item.done).length;

  return (
    <div role="region" aria-label="ARIA Coaching" className="flex-1 min-h-0 flex flex-col bg-white border border-indigo-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Header (static — no collapse toggle) */}
      <div className="w-full flex-none flex items-center justify-between px-4 py-3 bg-indigo-600 text-white text-sm font-semibold">
        <span className="flex items-center gap-2">
          <span>🧭</span>
          <span>ARIA Coaching</span>
          {urgent && (
            <span className="ml-1 bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full animate-pulse">
              💡 Tip
            </span>
          )}
          {!urgent && checklist.length > 0 && (
            <span className="ml-1 text-indigo-300 text-xs">
              {doneCount}/{checklist.length} done
            </span>
          )}
        </span>
      </div>

      {/* Body — always rendered, fills remaining panel height, scrolls internally if content overflows.
          Troy's space-between ask: once hasAnyCoachingData is true, the first
          section pins to the top, the last section pins to the bottom, and
          everything between gets evenly distributed spacing (`justify-between`,
          flex column) instead of the fixed `space-y-4` gap. The exception — the
          fully-empty "Waiting on data..." state — keeps the exact `space-y-4`
          layout it always had. */}
      <div
        data-coaching-body
        className={
          hasAnyCoachingData
            ? 'flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col justify-between gap-4'
            : 'flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4'
        }
      >


          {/* ── DISC card ── */}
          <div data-coaching-section="disc" className="bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-3">
            <div className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">DISC Style</div>
            {hasDisc && disc ? (
              <div className="flex items-center gap-3">
                {disc.emoji && (
                  <span className="text-4xl leading-none">{disc.emoji}</span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {disc.label && (
                      <span className="text-sm font-bold text-indigo-900">{disc.label}</span>
                    )}
                    {disc.confidence && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONFIDENCE_STYLES[disc.confidence] || CONFIDENCE_STYLES.low}`}>
                        {disc.confidence}
                      </span>
                    )}
                  </div>
                  {disc.tip && (
                    <p className="text-xs text-indigo-600 italic mt-0.5">{disc.tip}</p>
                  )}
                </div>
              </div>
            ) : (
              <p data-coaching-waiting="disc" className="text-sm text-indigo-500">Waiting on data...</p>
            )}
          </div>

          {/* ── Situational DISC coaching (urgent) ── */}
          <div data-coaching-section="urgent">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Urgent Alert</div>
            {urgent ? (
              <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-3 flex gap-2">
                <span className="text-lg leading-none flex-shrink-0 mt-0.5">💡</span>
                <p className="text-sm text-orange-900 leading-snug">{urgent}</p>
              </div>
            ) : (
              <p data-coaching-waiting="urgent" className="text-sm text-gray-400">Waiting on data...</p>
            )}
          </div>

          {/* ── Sales stage ── */}
          <div data-coaching-section="stage">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stage</span>
              {hasStage && <span className="text-xs text-gray-500">{stageProgress}%</span>}
            </div>
            {hasStage && stage ? (
              <div className="text-sm font-medium text-gray-800 mb-1.5">{stage.label || stage.current}</div>
            ) : (
              <p data-coaching-waiting="stage" className="text-sm text-gray-400">Waiting on data...</p>
            )}
          </div>

          {/* ── Nudges ── (cycling, one at a time) */}
          <div data-coaching-section="nudges">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Next Move
              </span>
              {allNudges.length > 1 && (
                <span className="text-xs text-gray-400">
                  {safeIndex + 1}/{allNudges.length}
                </span>
              )}
            </div>

            {allNudges.length > 0 ? (
              <>
                {/* Current nudge — fades between transitions, never goes blank */}
                <div
                  onClick={handleNudgeTap}
                  style={{ transition: 'opacity 0.3s ease', opacity: visible ? 1 : 0 }}
                  className={`rounded-xl px-4 py-3 text-sm font-medium cursor-pointer select-none ${
                    displayNudge?.startsWith('🚨')
                      ? 'bg-red-50 border border-red-200 text-red-900'
                      : 'bg-yellow-50 border border-yellow-200 text-yellow-900'
                  }`}
                >
                  {displayNudge}
                  {paused && (
                    <span className="ml-2 text-xs opacity-50">⏸</span>
                  )}
                </div>

                {/* Dot navigation */}
                {allNudges.length > 1 && (
                  <div className="flex justify-center gap-1.5 mt-2">
                    {allNudges.map((_, i) => (
                      <button
                        key={i}
                        onClick={() => goToNudge(i)}
                        className={`rounded-full transition-all ${
                          i === safeIndex
                            ? 'w-4 h-2 bg-yellow-500'
                            : 'w-2 h-2 bg-gray-300 hover:bg-gray-400'
                        }`}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p data-coaching-waiting="nudges" className="text-sm text-gray-400">Waiting on data...</p>
            )}
          </div>

          {/* ── Stage progress bar ── */}
          {hasStage && (
            <div data-coaching-section="progress">
              <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${stageProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Checklist ── */}
          <div data-coaching-section="checklist">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">1st Go Around</span>
              {checklist.length > 0 && <span className="text-xs text-gray-500">{doneCount}/{checklist.length}</span>}
            </div>
            <div
              data-coaching-checklist
              className="grid grid-cols-1 sm:grid-cols-2 gap-2"
            >
              {checklist.length > 0 ? checklist.map(item => (
                <div
                  key={item.id}
                  data-coaching-checklist-item={item.id}
                  className={`min-w-0 flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${
                    item.done ? 'text-green-700' : 'text-gray-500'
                  }`}
                >
                  <span className="flex-shrink-0 text-base leading-none mt-0.5">
                    {item.done ? '✅' : '🔲'}
                  </span>
                  <span className={`min-w-0 break-words leading-snug ${item.done ? 'line-through opacity-70' : ''}`}>
                    {item.label}
                  </span>
                </div>
              )) : (
                <p data-coaching-waiting="checklist" className="text-sm text-gray-400">Waiting on data...</p>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}
