import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../src/App.jsx';
import Rca from '../src/pages/Rca.jsx';
import Compliance from '../src/pages/Compliance.jsx';
import Journey from '../src/pages/Journey.jsx';
import { MiniMarkdown } from '../src/ui.jsx';

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
function mockApi(routes) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    for (const [key, handler] of Object.entries(routes)) {
      if (`${method} ${url}`.startsWith(key)) return json(...[].concat(typeof handler === 'function' ? handler(init) : handler));
    }
    return json({ error: `unmocked ${method} ${url}` }, 404);
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ''; });

describe('shell', () => {
  beforeEach(() => { window.location.hash = '#/journey'; });
  it('always shows the synthetic-data banner and both sections', () => {
    mockApi({});
    render(<App />);
    expect(screen.getByRole('note').textContent).toBe('Synthetic data. Not a real lending system.');
    expect(screen.getByRole('link', { name: 'Journey' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Workbench' })).toBeTruthy();
  });
  it('shows the workbench tabs on the workbench route', () => {
    window.location.hash = '#/workbench/mock';
    mockApi({ 'GET /api/mock/status': { config: { bureau: { baseMs: 1800, multiplier: 1, errorRate: 0, timeoutRate: 0, forceScore: null }, kyc: { baseMs: 1100, multiplier: 1, errorRate: 0, timeoutRate: 0, forceVerified: null } }, recorded: { providers: [], applications: 0, bureau_unavailable_referrals: 0 }, scenarios: { normal: 'Nominal.' } } });
    render(<App />);
    for (const t of ['Funnel', 'Anomalies', 'RCA', 'Simulator', 'Compliance', 'Experiments', 'Mock controls']) expect(screen.getByRole('link', { name: t })).toBeTruthy();
  });
});

describe('RCA page', () => {
  const rca = {
    day: '2026-10-13', step: 'offer_viewed', label: 'Offer viewed', from_step: 'Eligibility passed',
    observed: { rate: 0.4, baseline_rate: 0.47, applications: 491, lost_conversions: 34 },
    decomposition: { today: { converted: 0.4, abandoned: 0.23, rejected: 0.2, sent_to_manual_review: 0.17 }, baseline: { converted: 0.47, abandoned: 0.03, rejected: 0.29, sent_to_manual_review: 0.21 } },
    hypotheses: [
      { id: 'release_ios_5_2', type: 'Release', title: 'Release ios 5.2', score: 0, verdict: 'ruled out', evidence: ['ios 5.2 declared no impact.'] },
      { id: 'api_latency', type: 'API latency', title: 'bureau API slowdown', score: 1, verdict: 'likely', evidence: ['bureau p95 above 2x baseline.'], timeline: [{ hour: 11, p95_ms: 6000, calls: 10, failed: 4 }], details: { threshold_ms: 1952 } },
    ],
    caveat: 'Correlation under a modelled counterfactual, not proof of causation.', narrative: 'Conversion fell on the day.',
  };
  it('ranks the highest-scoring hypothesis first and shows the caveat', async () => {
    mockApi({ 'GET /api/rca': rca });
    render(<Rca params={{ day: '2026-10-13', step: 'offer_viewed' }} />);
    await waitFor(() => expect(screen.getByText(/1\. bureau API slowdown/)).toBeTruthy());
    expect(screen.getByText(/2\. Release ios 5.2/)).toBeTruthy();
    expect(screen.getByText(/not proof of causation/)).toBeTruthy();
    expect(screen.getAllByRole('meter')[0].getAttribute('aria-valuenow')).toBe('100');
  });
  it('shows the server message when there is not enough data', async () => {
    mockApi({ 'GET /api/rca': [{ error: 'not enough data for a baseline' }, 422] });
    render(<Rca params={{ day: '2026-09-10', step: 'offer_viewed' }} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not enough data/));
  });
});

describe('Compliance page', () => {
  const NOTICE = 'Source: RBI Digital Lending Directions, 2025. The PDF is stamped "Withdrawn". Not legal advice.';
  const sources = { title: 'Directions', doc_id: 'RBI/2025-26/36', chunks: 99, status_in_pdf: 'Withdrawn', clauses: [{ clause: 'Clause 10', heading: 'Cooling-off period' }], notice: NOTICE };
  it('shows citations and the withdrawn-source notice for an answer', async () => {
    mockApi({
      'GET /api/compliance/sources': sources,
      'POST /api/compliance/ask': { found: true, answer: '', citations: [{ label: 'Clause 10, para (i)', heading: 'Cooling-off period', chapter: 'Chapter III', quote: 'The borrower shall be given an explicit option to exit.', rank: 0.9 }], notice: NOTICE },
    });
    render(<Compliance />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'cooling-off period?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText('Clause 10, para (i)')).toBeTruthy());
    expect(screen.getByText(/explicit option to exit/)).toBeTruthy();
    expect(screen.getAllByText(/Withdrawn/).length).toBeGreaterThan(0);
  });
  it('shows "Not found" and keeps the notice', async () => {
    mockApi({
      'GET /api/compliance/sources': sources,
      'POST /api/compliance/ask': { found: false, answer: 'Not found in the Directions. Try rephrasing.', citations: [], notice: NOTICE },
    });
    render(<Compliance />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'who won the cricket' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText(/Not found in the Directions/)).toBeTruthy());
    expect(screen.getByText(/Not legal advice/)).toBeTruthy();
  });
  it('rejects an empty question without calling the API', () => {
    const calls = mockApi({ 'GET /api/compliance/sources': sources });
    render(<Compliance />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('alert').textContent).toMatch(/at least 3 characters/);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

describe('Journey page', () => {
  it('walks start, KYC, eligibility, offer (with KFS) and accept, locking later steps until earlier ones pass', async () => {
    const calls = mockApi({
      'POST /api/applications/7/kyc': { status: 'verified' },
      'POST /api/applications/7/eligibility': { decision: 'pass' },
      'POST /api/applications/7/offer': { decision: 'approve', offer: { loan_amount: 300000, tenure_months: 36, interest_rate_pa: 0.13, emi: 10107, processing_fee: 6000, net_disbursed: 294000, total_interest: 63852, total_repayment: 363852, apr: 0.15, cooling_off_days: 3, grievance_officer: 'Demo officer', note: 'Demo values on synthetic data.' } },
      'POST /api/applications/7/accept': { status: 'disbursed', amount: 300000, cooling_off_days: 3 },
      'POST /api/applications': [{ id: 7, next: 'kyc' }, 201],
      'GET /api/applications/7': { application: {}, events: [{ event_type: 'application_started', ts: '2026-10-20T10:00:00Z' }] },
    });
    render(<Journey />);
    expect(screen.queryByRole('button', { name: /Verify identity/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start application' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Verify identity/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Verify identity/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Check eligibility/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Check eligibility/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Get offer/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Get offer/ }));
    await waitFor(() => expect(screen.getByText(/Key Fact Statement/)).toBeTruthy());
    expect(screen.getByText('Demo officer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept offer' }));
    await waitFor(() => expect(screen.getByText(/Simulated disbursal/)).toBeTruthy());
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(5);
  });
  it('shows reason codes when the offer is a referral', async () => {
    mockApi({
      'POST /api/applications/9/kyc': { status: 'verified' },
      'POST /api/applications/9/eligibility': { decision: 'pass' },
      'POST /api/applications/9/offer': { decision: 'refer', message: 'A credit officer will review.', reasons: [{ code: 'BUREAU_UNAVAILABLE', message: 'We could not verify some of your information.' }] },
      'POST /api/applications': [{ id: 9 }, 201],
      'GET /api/applications/9': { application: {}, events: [] },
    });
    render(<Journey />);
    fireEvent.click(screen.getByRole('button', { name: 'Start application' }));
    await waitFor(() => screen.getByRole('button', { name: /Verify identity/ }));
    fireEvent.click(screen.getByRole('button', { name: /Verify identity/ }));
    await waitFor(() => screen.getByRole('button', { name: /Check eligibility/ }));
    fireEvent.click(screen.getByRole('button', { name: /Check eligibility/ }));
    await waitFor(() => screen.getByRole('button', { name: /Get offer/ }));
    fireEvent.click(screen.getByRole('button', { name: /Get offer/ }));
    await waitFor(() => expect(screen.getByText('BUREAU_UNAVAILABLE')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Accept offer' })).toBeNull();
  });
});

describe('MiniMarkdown', () => {
  it('renders headings, bullets, quotes, bold and tables', () => {
    const { container } = render(<MiniMarkdown text={'# Title\n\n> **Synthetic data.** note\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'} />);
    expect(container.querySelector('h3.md-title').textContent).toBe('Title');
    expect(container.querySelector('blockquote strong').textContent).toBe('Synthetic data.');
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
    expect(container.querySelector('th').textContent).toBe('A');
  });
});

describe('page chrome', () => {
  it('sets the tab title and one hidden h1 per page, and offers a skip link', async () => {
    window.location.hash = '#/workbench/compliance';
    mockApi({ 'GET /api/compliance/sources': { title: 'Directions', doc_id: 'RBI/2025-26/36', chunks: 99, status_in_pdf: 'Withdrawn', clauses: [], notice: 'n' } });
    render(<App />);
    expect(document.title).toBe('Compliance · LoanLens');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Compliance']);
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
  });
});

describe('API errors', () => {
  it('says the API is down when a proxy answers 5xx with no JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) })));
    const { get } = await import('../src/lib.js');
    await expect(get('/api/meta')).rejects.toThrow(/API is not responding/);
  });
  it('keeps the server message when the body is JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'age must be a number between 18 and 100' }) })));
    const { get } = await import('../src/lib.js');
    await expect(get('/api/x')).rejects.toThrow(/age must be/);
  });
});
