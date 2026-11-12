import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { parseRoute, routeHref } from './lib.js';
import Journey from './pages/Journey.jsx';
import { Loading } from './ui.jsx';

// The workbench pages carry the charting library, which is most of the bundle; they load when their tab is opened, so the first screen
// (the journey) arrives without them.
const Funnel = lazy(() => import('./pages/Funnel.jsx'));
const Anomalies = lazy(() => import('./pages/Anomalies.jsx'));
const Rca = lazy(() => import('./pages/Rca.jsx'));
const Simulator = lazy(() => import('./pages/Simulator.jsx'));
const Compliance = lazy(() => import('./pages/Compliance.jsx'));
const Experiments = lazy(() => import('./pages/Experiments.jsx'));
const MockControls = lazy(() => import('./pages/MockControls.jsx'));

export const TABS = [
  ['funnel', 'Funnel', Funnel],
  ['anomalies', 'Anomalies', Anomalies],
  ['rca', 'RCA', Rca],
  ['simulator', 'Simulator', Simulator],
  ['compliance', 'Compliance', Compliance],
  ['experiments', 'Experiments', Experiments],
  ['mock', 'Mock controls', MockControls],
];

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function useTheme() {
  const read = () => { try { return localStorage.getItem('loanlens-theme'); } catch { return null; } };
  const [theme, setTheme] = useState(() => read() ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('loanlens-theme', theme); } catch { /* storage blocked: the choice just won't persist */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export default function App() {
  const hash = useHash();
  const [theme, toggle] = useTheme();
  const route = parseRoute(hash);
  const onWorkbench = route.page === 'workbench';
  const active = TABS.find(([k]) => k === route.tab) ?? TABS[0];
  const Page = active[2];
  const tabsRef = useRef(null);
  const pageName = onWorkbench ? active[1] : 'Journey';
  // each page gets its own tab title and one (visually hidden) h1, so screen readers and the browser history say where you are
  useEffect(() => { document.title = `${pageName} · LoanLens`; }, [pageName]);
  // on a narrow screen the tab row scrolls sideways: keep the current tab in view
  useEffect(() => {
    const el = tabsRef.current?.querySelector('a.active');
    if (el?.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [active[0], onWorkbench]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="banner" role="note">Synthetic data. Not a real lending system.</div>
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M20 20l7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
          <span>LoanLens</span>
        </div>
        <nav className="nav" aria-label="Main">
          <a href={routeHref('journey')} className={!onWorkbench ? 'active' : ''}>Journey</a>
          <a href={routeHref('workbench', 'funnel')} className={onWorkbench ? 'active' : ''}>Workbench</a>
        </nav>
        <button className="themebtn" onClick={toggle} aria-label="Toggle light or dark theme" title="Toggle light or dark theme">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {theme === 'dark'
              ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
              : <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />}
          </svg>
          <span className="lbl">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </header>

      {onWorkbench ? (
        <>
          <div className="tabs-wrap">
            <nav className="tabs" aria-label="Workbench" ref={tabsRef}>
              {TABS.map(([k, label]) => (
                <a key={k} href={routeHref('workbench', k)} className={k === active[0] ? 'active' : ''} aria-current={k === active[0] ? 'page' : undefined}>{label}</a>
              ))}
            </nav>
          </div>
          <main className="container" id="main" tabIndex={-1}><h1 className="sr-only">{pageName}</h1><Suspense fallback={<Loading what={pageName} />}><Page params={route.params} /></Suspense></main>
        </>
      ) : (
        <main className="container" id="main" tabIndex={-1}><h1 className="sr-only">{pageName}</h1><Journey /></main>
      )}
    </>
  );
}
