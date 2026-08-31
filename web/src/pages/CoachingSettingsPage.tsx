import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppPageLayout from '../components/AppPageLayout';
import SalesStagesSection from '../components/coaching-settings/SalesStagesSection';
import ObjectionsSection from '../components/coaching-settings/ObjectionsSection';
import CoachingPromptsSection from '../components/coaching-settings/CoachingPromptsSection';

// CoachingSettingsPage — the merged "Coaching" tab (2026-08-30,
// aria_coaching_settings_merge_objections_frontend), per Gabe's explicit
// ask: "Combine the objections tab and the coaching tab into the coaching
// tab. This should be the central location for all coaching settings. I
// also want to be able to edit the prompts that the LLM's get during
// coaching and maybe other features in the future."
//
// Replaces the standalone CoachingStagesPage.tsx (Sales Stages only) and
// ObjectionsPage.tsx (Objections library only) as separate top-level nav
// tabs/routes with ONE "Coaching" tab at /coaching, internally organized
// into three sub-sections via a segmented control:
//   - Sales Stages   (SalesStagesSection.tsx    — was CoachingStagesPage.tsx)
//   - Objections     (ObjectionsSection.tsx     — was ObjectionsPage.tsx)
//   - Coaching Prompts (CoachingPromptsSection.tsx — new, backed by the
//     aria_coaching_settings_prompt_editor_backend API)
//
// This app has no prior in-app tabbed/segmented-content precedent
// (SettingsPage.tsx uses simple stacked cards, not sub-tabs), so this page
// establishes a minimal one: a horizontal, mobile-first pill/segmented
// nav directly under the shared AppHeader, matching this app's existing
// rounded-2xl-card visual language rather than introducing a new pattern.
// Selection is local component state (not sub-routes) — same
// state-toggle-over-nested-routing choice ObjectionsPage.tsx's own
// list<->detail toggle already made, since none of these three sections
// need a deep-linkable URL today.
//
// Each section's underlying logic/API calls are UNCHANGED from their
// original standalone pages — only the page-chrome (each page's own
// AppPageLayout/header/back-button) was stripped since there is now one
// shared AppPageLayout for the whole merged page. See each section
// component's own header comment for its specific extraction notes.

type Section = 'stages' | 'objections' | 'prompts';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'stages', label: 'Sales Stages' },
  { id: 'objections', label: 'Objections' },
  { id: 'prompts', label: 'Coaching Prompts' },
];

export default function CoachingSettingsPage() {
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>('stages');

  return (
    <AppPageLayout
      title="Coaching"
      subtitle="Central settings for ARIA's live coaching: stages, objections, and LLM prompts."
      onBack={() => navigate('/')}
      contentClassName="max-w-lg mx-auto"
    >
      <div
        role="tablist"
        aria-label="Coaching settings sections"
        className="flex gap-2 mb-4 bg-white rounded-2xl shadow-sm border border-gray-100 p-1.5 overflow-x-auto"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={`flex-1 min-w-0 whitespace-nowrap text-sm font-semibold px-3 py-2 rounded-xl transition-colors ${
              section === s.id
                ? 'bg-brand-700 text-white'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'stages' && <SalesStagesSection />}
      {section === 'objections' && <ObjectionsSection />}
      {section === 'prompts' && <CoachingPromptsSection />}
    </AppPageLayout>
  );
}
