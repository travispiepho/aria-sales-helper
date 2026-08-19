/**
 * RebuttalTeleprompter.tsx — Live rebuttal teleprompter panel (2026-08-18,
 * in-meeting surfacing pass).
 *
 * Consumes `suggested_rebuttal_library` WS pushes (server.js's
 * /meetings/:id/audio handler + telephony.js's /telephony/stream handler,
 * both backed by server/objectionLibraryMatcher.js matching against the
 * Objections/Rebuttals library from commit 053c81e) and renders them as a
 * readable-at-a-glance card the rep can read from mid-conversation.
 *
 * Deliberately separate component from the existing inline
 * `suggestedRebuttal` banner in MeetingPage.tsx (the OLDER
 * objectionDetection.js STUB + Claude-generated-rebuttal pipeline, item 5's
 * original first pass) — both now render side by side; see MeetingPage.tsx
 * for why neither replaces the other.
 *
 * UI requirements from the brief, all addressed here:
 *   - Large enough text to read mid-sentence: rebuttal text is text-lg/xl,
 *     bold, high-contrast.
 *   - Multiple rebuttals per objection: prev/next pager, current index
 *     shown ("1 / 3"), oldest-first order (matches the library's own
 *     created_at ASC convention, i.e. index 0 is the same rebuttal
 *     ObjectionsPage.tsx would show first).
 *   - Per-prompt dismiss control.
 *   - Usable at 390x844: fixed max-height with internal scroll for a long
 *     rebuttal, generous tap targets (Prev/Next/Dismiss all >= 44px tall),
 *     does not use position:fixed itself (parent MeetingPage.tsx places it
 *     in the normal scrollable content column, same as the existing
 *     suggestedRebuttal banner, coaching panel, etc.) so it never overlaps
 *     the transcript or the fixed bottom End Meeting / Hang Up bar.
 */

import React, { useState, useEffect } from 'react';

export interface LibraryRebuttal {
  id: string;
  text: string;
}

export interface SuggestedLibraryRebuttal {
  objectionId: string;
  objectionText: string;
  objectionCategory: string | null;
  rebuttals: LibraryRebuttal[];
  matchedSegmentText: string;
  confidence: number;
  matchMethod: 'substring' | 'keyword_overlap' | string;
}

interface RebuttalTeleprompterProps {
  prompts: SuggestedLibraryRebuttal[];
  onDismiss: (objectionId: string) => void;
}

function SinglePromptCard({ prompt, onDismiss }: { prompt: SuggestedLibraryRebuttal; onDismiss: (objectionId: string) => void }) {
  const [index, setIndex] = useState(0);
  // Reset the pager if a fresh push for the SAME objection arrives with a
  // different rebuttal set (e.g. a rep added a new rebuttal mid-call) —
  // avoids an out-of-range index.
  useEffect(() => {
    if (index >= prompt.rebuttals.length) setIndex(0);
  }, [prompt.rebuttals.length, index]);

  const rebuttal = prompt.rebuttals[index] ?? prompt.rebuttals[0];
  const hasMultiple = prompt.rebuttals.length > 1;

  return (
    <div
      className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 shadow-md"
      data-testid="rebuttal-teleprompter-card"
      data-objection-id={prompt.objectionId}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide">
            💬 Objection detected{prompt.objectionCategory ? ` · ${prompt.objectionCategory}` : ''}
          </p>
          <p className="text-xs text-amber-700 mt-0.5 truncate" title={prompt.objectionText}>
            "{prompt.objectionText}"
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(prompt.objectionId)}
          aria-label="Dismiss rebuttal suggestion"
          className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-amber-500 hover:text-amber-700 text-lg rounded-full hover:bg-amber-100"
        >
          ✕
        </button>
      </div>

      <div className="max-h-40 overflow-y-auto">
        <p className="text-lg font-bold text-gray-900 leading-snug">
          {rebuttal ? rebuttal.text : 'No rebuttal text saved for this objection.'}
        </p>
      </div>

      {hasMultiple && (
        <div className="flex items-center justify-between mt-3 pt-2 border-t border-amber-200">
          <button
            type="button"
            onClick={() => setIndex((i) => (i - 1 + prompt.rebuttals.length) % prompt.rebuttals.length)}
            className="min-w-[44px] min-h-[44px] px-3 flex items-center justify-center text-amber-700 font-semibold rounded-lg hover:bg-amber-100"
            aria-label="Previous rebuttal"
          >
            ← Prev
          </button>
          <span className="text-xs font-medium text-amber-600">
            {index + 1} / {prompt.rebuttals.length}
          </span>
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % prompt.rebuttals.length)}
            className="min-w-[44px] min-h-[44px] px-3 flex items-center justify-center text-amber-700 font-semibold rounded-lg hover:bg-amber-100"
            aria-label="Next rebuttal"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

export default function RebuttalTeleprompter({ prompts, onDismiss }: RebuttalTeleprompterProps) {
  if (!prompts || prompts.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="rebuttal-teleprompter">
      {prompts.map((p) => (
        <SinglePromptCard key={p.objectionId} prompt={p} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
