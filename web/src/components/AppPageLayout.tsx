import React from 'react';
import AppHeader from './AppHeader';

interface AppPageLayoutProps extends React.ComponentProps<typeof AppHeader> {
  children: React.ReactNode;
  contentClassName?: string;
}

/**
 * Shared authenticated-page shell. The header and page content are adjacent
 * block-level siblings so the content always follows the complete (possibly
 * wrapped) navigation in normal document flow.
 */
export default function AppPageLayout({
  children,
  contentClassName = '',
  ...headerProps
}: AppPageLayoutProps) {
  return (
    <div data-page-layout="flow" className="min-h-screen bg-gray-200">
      <AppHeader {...headerProps} />
      <main data-page-content className={`px-4 pt-4 pb-24 ${contentClassName}`.trim()}>
        {children}
      </main>
    </div>
  );
}
