import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const AppNavigationVisibilityContext = React.createContext(true);

export function AppNavigationVisibility({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <AppNavigationVisibilityContext.Provider value={visible}>
      {children}
    </AppNavigationVisibilityContext.Provider>
  );
}

interface AppHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  backTo?: string;
  onBack?: () => void;
  backLabel?: string;
  toneClassName?: string;
  status?: React.ReactNode;
}

const navItemClass =
  'w-11 h-11 rounded-full bg-white/10 border-2 border-white/25 hover:bg-white/20 flex items-center justify-center text-white transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-700';

export default function AppHeader({
  title,
  subtitle,
  toneClassName = 'bg-brand-700',
  status,
}: AppHeaderProps) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigationVisible = React.useContext(AppNavigationVisibilityContext);
  const current = (path: string) =>
    path === '/objections' || path === '/meetings'
      ? pathname === path || pathname.startsWith(`${path}/`)
      : pathname === path;

  const primary = (
    <div className="flex min-w-0 flex-1 items-center gap-2 max-[480px]:w-full max-[480px]:flex-none">
      <Link
        to="/"
        aria-label="Home"
        aria-current={current('/') ? 'page' : undefined}
        className="h-11 min-w-11 px-1 rounded-lg flex flex-shrink-0 items-center justify-center text-white hover:bg-white/10 text-lg font-bold leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        ARIA
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className={title === 'ARIA' ? 'sr-only' : 'text-xl sm:text-2xl font-bold leading-tight truncate'}>{title}</h1>
        {subtitle && <div className="text-white/75 text-sm leading-snug truncate">{subtitle}</div>}
      </div>
      {status && <div className="flex-shrink-0">{status}</div>}
    </div>
  );

  return (
    <header
      data-app-header="compact"
      data-compact-min-height="104px"
      className={`${toneClassName} text-white px-4 py-2.5 min-h-[6.5rem] flex items-center transition-colors`}
    >
      <div className="w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {primary}
        {navigationVisible && <nav
          aria-label="Authenticated navigation"
          className="ml-auto flex flex-shrink-0 flex-wrap items-center justify-center gap-2 max-[480px]:mx-auto max-[480px]:w-full"
        >
          <Link
            to="/"
            aria-label="Meet"
            aria-current={current('/') ? 'page' : undefined}
            className={`h-11 min-w-11 px-3 rounded-full bg-white/10 border-2 border-white/25 hover:bg-white/20 flex items-center justify-center text-white text-sm font-semibold transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-700 ${current('/') ? 'ring-2 ring-white' : ''}`}
          >
            Meet
          </Link>
          <Link
            to="/meetings"
            aria-label="Recorded"
            aria-current={current('/meetings') ? 'page' : undefined}
            className={`h-11 min-w-11 px-3 rounded-full bg-white/10 border-2 border-white/25 hover:bg-white/20 flex items-center justify-center gap-2 text-white transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-700 ${current('/meetings') ? 'ring-2 ring-white' : ''}`}
          >
            <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M8 2v4M16 2v4M3 10h18" />
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
            </svg>
            <span className="text-sm font-semibold">Recorded</span>
          </Link>
          <Link
            to="/objections"
            aria-label="Objections"
            aria-current={current('/objections') ? 'page' : undefined}
            className={`${navItemClass} ${current('/objections') ? 'ring-2 ring-white' : ''}`}
          >
            <span className="text-lg leading-none" aria-hidden="true">💬</span>
          </Link>
          <Link
            to="/settings"
            aria-label="Settings"
            aria-current={current('/settings') ? 'page' : undefined}
            className={`${navItemClass} ${current('/settings') ? 'ring-2 ring-white' : ''}`}
          >
            <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
          <Link
            to="/profile"
            aria-label="Profile"
            aria-current={current('/profile') ? 'page' : undefined}
            className={`${navItemClass} font-bold text-base ${current('/profile') ? 'ring-2 ring-white' : ''}`}
          >
            {user?.name?.charAt(0)?.toUpperCase() || '?'}
          </Link>
        </nav>}
      </div>
    </header>
  );
}
