/**
 * CoachingPanel.tsx — Phase 3: Real-Time Coaching Overlay
 * Displays DISC style, sales stage, checklist, nudges, and urgent alerts.
 * Mobile-first, collapsible, Tailwind-only.
 */

import React, { useState, useEffect, useRef } from 'react';

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
  disc: CoachingDisc;
  stage: CoachingStage;
  checklist: CoachingChecklistItem[];
  nudges: string[];
  urgent: string | null;
}

interface CoachingPanelProps {
  coaching: CoachingData | null;
  defaultCollapsed?: boolean;
}

// ─── Stage progress order ─────────────────────────────────────────────────────

const STAGE_ORDER = [
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

// ─── Confidence colors ────────────────────────────────────────────────────────

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-gray-100 text-gray-600',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function CoachingPanel({ coaching, defaultCollapsed = false }: CoachingPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [nudgeIndex, setNudgeIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allNudges = [
    ...(coaching?.nudges || []),
    ...(coaching?.urgent ? [`🚨 ${coaching.urgent}`] : []),
  ];

  // Cycle nudges every 10 seconds unless paused
  useEffect(() => {
    if (allNudges.length <= 1 || paused) return;
    const timer = setInterval(() => {
      setNudgeIndex(i => (i + 1) % allNudges.length);
    }, 10000);
    return () => clearInterval(timer);
  }, [allNudges.length, paused]);

  // Reset index when nudges change (new coaching pass)
  useEffect(() => {
    setNudgeIndex(0);
  }, [coaching]);

  function handleNudgeTap() {
    // Tap to pause for 20s, then resume
    setPaused(true);
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = setTimeout(() => setPaused(false), 20000);
  }

  function goToNudge(i: number) {
    setNudgeIndex(i);
    setPaused(true);
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = setTimeout(() => setPaused(false), 20000);
  }

  if (!coaching) {
    return (
      <div className="bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-3 flex items-center gap-2 text-sm text-indigo-500">
        <span className="text-lg">🧭</span>
        <span>ARIA coaching will appear after a few transcript segments…</span>
      </div>
    );
  }

  const { disc, stage, checklist, nudges, urgent } = coaching;

  const stageIndex = STAGE_ORDER.indexOf(stage.current);
  const stageProgress = stageIndex >= 0 ? Math.round(((stageIndex + 1) / STAGE_ORDER.length) * 100) : 0;

  const doneCount = checklist.filter(item => item.done).length;

  return (
    <div className="bg-white border border-indigo-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Header / collapse toggle */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 bg-indigo-600 text-white text-sm font-semibold"
      >
        <span className="flex items-center gap-2">
          <span>🧭</span>
          <span>ARIA Coaching</span>
          {!collapsed && urgent && (
            <span className="ml-1 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full animate-pulse">
              ⚡ Urgent
            </span>
          )}
          {!collapsed && !urgent && (
            <span className="ml-1 text-indigo-300 text-xs">
              {doneCount}/{checklist.length} done
            </span>
          )}
        </span>
        <span className="text-indigo-200 text-lg leading-none">
          {collapsed ? '▾' : '▴'}
        </span>
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="px-4 py-3 space-y-4">


          {/* ── DISC card ── */}
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-3">
            <div className="flex items-center gap-3">
              {disc.emoji && (
                <span className="text-4xl leading-none">{disc.emoji}</span>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-indigo-900">
                    {disc.label}
                  </span>
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
          </div>

          {/* ── Sales stage ── */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stage</span>
              <span className="text-xs text-gray-500">{stageProgress}%</span>
            </div>
            <div className="text-sm font-medium text-gray-800 mb-1.5">{stage.label}</div>
            <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                style={{ width: `${stageProgress}%` }}
              />
            </div>
          </div>

          {/* ── Checklist ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">1st Go Around</span>
              <span className="text-xs text-gray-500">{doneCount}/{checklist.length}</span>
            </div>
            <div className="space-y-1.5">
              {checklist.map(item => (
                <div
                  key={item.id}
                  className={`flex items-center gap-2 text-sm rounded-lg px-2 py-1 ${
                    item.done ? 'text-green-700' : 'text-gray-500'
                  }`}
                >
                  <span className="flex-shrink-0 text-base leading-none">
                    {item.done ? '✅' : '🔲'}
                  </span>
                  <span className={item.done ? 'line-through opacity-70' : ''}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Nudges ── (cycling, one at a time) */}
          {allNudges.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Next Move
                </span>
                {allNudges.length > 1 && (
                  <span className="text-xs text-gray-400">
                    {nudgeIndex + 1}/{allNudges.length}
                  </span>
                )}
              </div>

              {/* Current nudge */}
              <div
                onClick={handleNudgeTap}
                className={`rounded-xl px-4 py-3 text-sm font-medium cursor-pointer select-none transition-colors ${
                  allNudges[nudgeIndex]?.startsWith('🚨')
                    ? 'bg-red-50 border border-red-200 text-red-900'
                    : 'bg-yellow-50 border border-yellow-200 text-yellow-900'
                }`}
              >
                {allNudges[nudgeIndex]}
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
                        i === nudgeIndex
                          ? 'w-4 h-2 bg-yellow-500'
                          : 'w-2 h-2 bg-gray-300 hover:bg-gray-400'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
