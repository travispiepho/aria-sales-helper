/**
 * CoachingReportCard.tsx — ARIA Priority 1 roadmap (2026-08-05)
 *
 * Manager-facing coaching report (item 6) combining:
 *   - BANT + closing certainty % (item 1)
 *   - Insider-language flags (item 3)
 *   - Question-listening gaps (item 4)
 *   - Existing coaching metrics (Meeting Score, WPM, DISC adaptation)
 *
 * Item 2 (TEPIT) intentionally not included — not defined, out of scope.
 *
 * Pattern matches MeetingScoreCard.tsx (same card shell, same
 * score-color helpers, same GET-on-mount + loading/error states).
 * "Generate / Refresh Report" button chains the three analysis POST
 * endpoints (BANT, insider-language, question-gaps) then refetches the
 * aggregate GET — since analysis is post-call and can take a few seconds
 * per LLM call, this is a manual trigger, not automatic on page load
 * (matching the existing "Generate Summary" button's deliberate manual-
 * trigger pattern for the same reason: avoid unconditional AI cost).
 */

import React, { useEffect, useState } from 'react';
import {
  getCoachingReport,
  runBantAnalysis,
  runInsiderLanguageAnalysis,
  runQuestionGapAnalysis,
  CoachingReport,
} from '../lib/api';

interface CoachingReportCardProps {
  meetingId: string;
}

function scoreColor(value: number | null): string {
  if (value === null) return 'text-gray-300';
  if (value >= 70) return 'text-green-600';
  if (value >= 40) return 'text-amber-500';
  return 'text-red-500';
}

function scoreBg(value: number | null): string {
  if (value === null) return 'bg-gray-100';
  if (value >= 70) return 'bg-green-50';
  if (value >= 40) return 'bg-amber-50';
  return 'bg-red-50';
}

function formatMinutes(min: number | null): string {
  if (min === null || min === undefined) return '';
  return `${Math.round(min)}m in`;
}

export default function CoachingReportCard({ meetingId }: CoachingReportCardProps) {
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    getCoachingReport(meetingId)
      .then(res => {
        setReport(res);
        setNotFound(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load coaching report');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      // Run all three analyses. Each is independent — collect failures but
      // don't let one block the others (e.g. a meeting with a very short
      // transcript may not have enough segments for question-gap detection
      // but can still get a BANT score).
      const results = await Promise.allSettled([
        runBantAnalysis(meetingId),
        runInsiderLanguageAnalysis(meetingId),
        runQuestionGapAnalysis(meetingId),
      ]);
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length === 3) {
        throw new Error('All analyses failed — check server logs / migration status.');
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate coaching report');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Coaching Report</h3>
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  const hasBant = !!report?.bant;
  const hasInsider = (report?.insiderLanguageFlags?.length ?? 0) > 0;
  const hasGaps = (report?.questionGaps?.length ?? 0) > 0;
  const hasAnyAnalysis = hasBant || hasInsider || hasGaps;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Coaching Report</h3>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
        >
          {generating ? 'Generating…' : hasAnyAnalysis ? '↻ Refresh' : '✨ Generate'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2 mb-3">{error}</p>
      )}

      {!hasAnyAnalysis && !generating && (
        <p className="text-sm text-gray-400 py-2">
          No BANT / insider-language / question-gap analysis generated yet. Tap Generate.
        </p>
      )}

      {/* BANT + closing certainty */}
      {hasBant && report?.bant && (
        <div className="mb-4">
          <div className={`flex items-center gap-4 rounded-xl p-4 mb-3 ${scoreBg(report.bant.closing_certainty_pct)}`}>
            <div className={`text-4xl font-bold ${scoreColor(report.bant.closing_certainty_pct)}`}>
              {report.bant.closing_certainty_pct}%
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-700">Closing Certainty</p>
              <p className="text-xs text-gray-500">{report.bant.rationale?.overall || 'BANT-derived estimate'}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['Budget', report.bant.budget_score, report.bant.rationale?.budget],
              ['Authority', report.bant.authority_score, report.bant.rationale?.authority],
              ['Need', report.bant.need_score, report.bant.rationale?.need],
              ['Timeline', report.bant.timeline_score, report.bant.rationale?.timeline],
            ] as [string, number, string | undefined][]).map(([label, value, rationale]) => (
              <div key={label} className="bg-gray-50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className={`text-sm font-bold ${scoreColor(value)}`}>{value}</p>
                </div>
                {rationale && <p className="text-xs text-gray-500">{rationale}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Insider-language flags */}
      {hasInsider && (
        <div className="border-t border-gray-100 pt-3 mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Insider Language Flagged ({report!.insiderLanguageFlags.length})
          </p>
          <div className="space-y-2">
            {report!.insiderLanguageFlags.map(flag => (
              <div key={flag.id} className="bg-amber-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-amber-800">"{flag.phrase}"</span>
                  {flag.minutes_in !== null && (
                    <span className="text-xs text-amber-600">{formatMinutes(flag.minutes_in)}</span>
                  )}
                </div>
                {flag.explanation && <p className="text-xs text-amber-700 mt-0.5">{flag.explanation}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Question-listening gaps */}
      {hasGaps && (
        <div className="border-t border-gray-100 pt-3 mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Unanswered Questions ({report!.questionGaps.length})
          </p>
          <div className="space-y-2">
            {report!.questionGaps.map(gap => (
              <div key={gap.id} className="bg-red-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-red-800">"{gap.question_text}"</span>
                  {gap.question_minutes_in !== null && (
                    <span className="text-xs text-red-600">{formatMinutes(gap.question_minutes_in)}</span>
                  )}
                </div>
                {gap.explanation && <p className="text-xs text-red-700 mt-0.5">{gap.explanation}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Existing coaching metrics recap */}
      {report && (
        <div className="border-t border-gray-100 pt-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Summary Metrics</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-400 mb-1">Meeting Score</p>
              <p className={`text-lg font-bold ${scoreColor(report.meetingScore)}`}>
                {report.meetingScore !== null ? report.meetingScore : '—'}
              </p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-400 mb-1">Checklist Coverage</p>
              <p className={`text-lg font-bold ${scoreColor(report.coveragePct)}`}>{report.coveragePct}%</p>
            </div>
            {report.wpm.avg !== null && (
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1">Speaking Pace</p>
                <p className="text-lg font-bold text-gray-800">{report.wpm.avg} WPM</p>
              </div>
            )}
            {report.discAdaptationScore !== null && (
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1">DISC Adaptation</p>
                <p className={`text-lg font-bold ${scoreColor(report.discAdaptationScore)}`}>
                  {report.discAdaptationScore}%
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
