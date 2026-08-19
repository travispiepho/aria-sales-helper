/**
 * MeetingScoreCard.tsx — Post-meeting analytics
 * Shows: composite Meeting Score, WPM/pacing, checklist sequencing/timing,
 * coverage %, DISC adaptation quality. Pulled from GET /api/meetings/:id/analytics.
 */

import React, { useEffect, useState } from 'react';
import { getMeetingAnalytics, MeetingAnalytics } from '../lib/api';

interface MeetingScoreCardProps {
  meetingId: string;
}

function scoreColor(value: number | null): string {
  if (value === null) return 'text-gray-300';
  if (value >= 80) return 'text-green-600';
  if (value >= 60) return 'text-amber-500';
  return 'text-red-500';
}

function scoreBg(value: number | null): string {
  if (value === null) return 'bg-gray-100';
  if (value >= 80) return 'bg-green-50';
  if (value >= 60) return 'bg-amber-50';
  return 'bg-red-50';
}

export default function MeetingScoreCard({ meetingId }: MeetingScoreCardProps) {
  const [data, setData] = useState<MeetingAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMeetingAnalytics(meetingId)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load analytics'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [meetingId]);

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Meeting Score</h3>
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Meeting Score</h3>
        <p className="text-sm text-gray-400">{error || 'No analytics available yet.'}</p>
      </div>
    );
  }

  const { wpm, checklistTiming, sequencing, coveragePct, discAdaptationScore, meetingScore, scoreComponents } = data;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Meeting Score</h3>

      {/* Composite score */}
      <div className={`flex items-center gap-4 rounded-xl p-4 mb-4 ${scoreBg(meetingScore)}`}>
        <div className={`text-4xl font-bold ${scoreColor(meetingScore)}`}>
          {meetingScore !== null ? meetingScore : '—'}
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-gray-700">Overall Meeting Score</p>
          <p className="text-xs text-gray-500">
            Weighted: coverage, sequencing, pacing, DISC adaptation
          </p>
        </div>
      </div>

      {/* Score breakdown */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {scoreComponents.map(c => (
          <div key={c.key} className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-400 mb-1">{c.label}</p>
            <p className={`text-lg font-bold ${scoreColor(c.value)}`}>{c.value}%</p>
          </div>
        ))}
      </div>

      {/* Word cadence / WPM */}
      <div className="border-t border-gray-100 pt-3 mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Speaking Pace</p>
        {wpm.avg !== null ? (
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-gray-800">{wpm.avg}</span>
            <span className="text-sm text-gray-500">WPM avg</span>
            {wpm.paceFlag && wpm.paceFlag !== 'good' && (
              <span className="ml-auto text-xs font-medium px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                {wpm.paceFlag === 'fast' ? 'Too fast' : 'Too slow'} · ideal {wpm.idealMin}-{wpm.idealMax}
              </span>
            )}
            {wpm.paceFlag === 'good' && (
              <span className="ml-auto text-xs font-medium px-2 py-1 rounded-full bg-green-100 text-green-700">
                On pace
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Not enough timed speech to calculate pace.</p>
        )}
      </div>

      {/* Checklist sequencing/timing */}
      <div className="border-t border-gray-100 pt-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Checklist Timing</p>
          <span className="text-xs text-gray-400">{coveragePct}% covered · {sequencing.score}% in order</span>
        </div>
        <div className="space-y-1.5">
          {checklistTiming.map(item => (
            <div key={item.id} className="flex items-center justify-between text-sm">
              <span className={item.hit ? 'text-gray-700' : 'text-gray-400'}>
                {item.hit ? '✅' : '⬜'} {item.label}
              </span>
              {item.hit && item.minutesIn !== null && (
                <span className="text-xs text-gray-400">{item.minutesIn}m in</span>
              )}
            </div>
          ))}
        </div>
        {sequencing.lateCriticalItems.length > 0 && (
          <div className="mt-2 bg-red-50 text-red-700 text-xs rounded-lg p-2">
            ⚠️ Hit late: {sequencing.lateCriticalItems.map(i => `${i.label} (${i.minutesIn}m in)`).join(', ')}
          </div>
        )}
      </div>

      {/* DISC adaptation */}
      {discAdaptationScore !== null && (
        <div className="border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">DISC Adaptation</p>
            <span className={`text-sm font-bold ${scoreColor(discAdaptationScore)}`}>{discAdaptationScore}%</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Based on how often live coaching flagged a style-mismatch correction.
          </p>
        </div>
      )}
    </div>
  );
}
