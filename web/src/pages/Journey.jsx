import { useState } from 'react';
import { get, post, inr, pct } from '../lib.js';
import { Card, ErrorBox, Notice, Chip, Field } from '../ui.jsx';

const DEFAULTS = {
  age: 34, employment: 'salaried', monthly_income: 60000, existing_emi: 5000,
  requested_amount: 300000, tenure_months: 36, new_to_credit: false, device: 'web', channel: 'organic',
};
const STEPS = ['Apply', 'KYC', 'Eligibility', 'Offer', 'Accept'];

function Kfs({ offer }) {
  const rows = [
    ['Loan amount', inr(offer.loan_amount)], ['Tenure', `${offer.tenure_months} months`], ['Interest rate (p.a.)', pct(offer.interest_rate_pa)],
    ['EMI', inr(offer.emi)], ['Processing fee', inr(offer.processing_fee)], ['Net amount disbursed', inr(offer.net_disbursed)],
    ['Total interest', inr(offer.total_interest)], ['Total repayment', inr(offer.total_repayment)], ['APR (illustrative method)', pct(offer.apr)],
    ['Cooling-off period', `${offer.cooling_off_days} days`], ['Grievance officer', offer.grievance_officer],
  ];
  return (
    <div className="stack">
      <h3>Key Fact Statement (shown before you accept)</h3>
      <div className="scroll"><table><tbody>{rows.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody></table></div>
      <div className="sub">{offer.note}</div>
    </div>
  );
}

const Reasons = ({ reasons }) => (
  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
    {reasons.map((r) => <li key={r.code}><code>{r.code}</code>: {r.message}</li>)}
  </ul>
);

export default function Journey() {
  const [form, setForm] = useState(DEFAULTS);
  const [id, setId] = useState(null);
  const [stage, setStage] = useState(0); // 0 = not started; steps below are 1-based completed count
  const [result, setResult] = useState({});
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const refreshEvents = async (appId) => { try { setEvents((await get(`/api/applications/${appId}`)).events); } catch { /* the trail is informational */ } };

  async function step(name, fn) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
    if (id) refreshEvents(id);
    return name;
  }
  const start = () => step('start', async () => {
    const body = { ...form, age: Number(form.age), monthly_income: Number(form.monthly_income), existing_emi: Number(form.existing_emi), requested_amount: Number(form.requested_amount), tenure_months: Number(form.tenure_months) };
    const r = await post('/api/applications', body);
    setId(r.id); setStage(1); setResult({}); setEvents([]); refreshEvents(r.id);
  });
  const kyc = () => step('kyc', async () => {
    const r = await post(`/api/applications/${id}/kyc`);
    setResult((x) => ({ ...x, kyc: r }));
    if (r.status === 'verified') setStage(2);
  });
  const eligibility = () => step('eligibility', async () => {
    const r = await post(`/api/applications/${id}/eligibility`);
    setResult((x) => ({ ...x, eligibility: r }));
    if (r.decision === 'pass') setStage(3);
  });
  const offer = () => step('offer', async () => {
    const r = await post(`/api/applications/${id}/offer`);
    setResult((x) => ({ ...x, offer: r }));
    if (r.decision === 'approve') setStage(4);
  });
  const accept = () => step('accept', async () => {
    const r = await post(`/api/applications/${id}/accept`);
    setResult((x) => ({ ...x, accept: r }));
    setStage(5);
  });
  const reset = () => { setId(null); setStage(0); setResult({}); setEvents([]); setError(null); };

  const locked = stage > 0;
  const terminal = result.eligibility?.decision === 'reject' || ['reject', 'refer'].includes(result.offer?.decision) || result.kyc?.status === 'failed';

  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <Card title="Apply for a personal loan" sub="A fabricated applicant. Every decision below comes from the deterministic rules engine.">
        <div className="grid fields">
          <Field label="Age"><input type="number" min="18" max="100" value={form.age} onChange={set('age')} disabled={locked} /></Field>
          <Field label="Employment">
            <select value={form.employment} onChange={set('employment')} disabled={locked}><option value="salaried">Salaried</option><option value="self_employed">Self-employed</option></select>
          </Field>
          <Field label="Monthly income (₹)"><input type="number" min="1" step="1000" value={form.monthly_income} onChange={set('monthly_income')} disabled={locked} /></Field>
          <Field label="Existing EMIs per month (₹)"><input type="number" min="0" step="500" value={form.existing_emi} onChange={set('existing_emi')} disabled={locked} /></Field>
          <Field label="Loan amount (₹)"><input type="number" min="10000" max="2000000" step="10000" value={form.requested_amount} onChange={set('requested_amount')} disabled={locked} /></Field>
          <Field label="Tenure (months)"><input type="number" min="6" max="84" step="6" value={form.tenure_months} onChange={set('tenure_months')} disabled={locked} /></Field>
          <Field label="Device">
            <select value={form.device} onChange={set('device')} disabled={locked}><option>web</option><option>android</option><option>ios</option></select>
          </Field>
          <Field label="Channel">
            <select value={form.channel} onChange={set('channel')} disabled={locked}><option>organic</option><option>paid</option><option>partner</option></select>
          </Field>
        </div>
        <label className="row" style={{ margin: '10px 0' }}><input type="checkbox" checked={form.new_to_credit} onChange={set('new_to_credit')} disabled={locked} /> New to credit (no bureau history)</label>
        <div className="row">
          <button className="primary" onClick={start} disabled={busy || locked}>Start application</button>
          {locked && <button onClick={reset}>New application</button>}
        </div>
        <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div>
      </Card>

      <div className="stack">
        <Card title={id ? `Application #${id}` : 'Progress'} sub="Journey: apply, KYC, eligibility, offer with KFS, accept">
          <div className="steps">
            {STEPS.map((s, i) => {
              const done = stage > i;
              const current = stage === i && !terminal;
              return (
                <div key={s} className={`step ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
                  <span className="n">{done ? '✓' : i + 1}</span>
                  <div>
                    <strong>{s}</strong>
                    {i === 1 && stage >= 1 && (
                      <div className="row" style={{ marginTop: 4 }}>
                        <button onClick={kyc} disabled={busy || stage !== 1}>Verify identity (mock KYC)</button>
                        {result.kyc && <Chip tone={result.kyc.status === 'verified' ? 'good' : 'bad'}>{result.kyc.status === 'verified' ? 'verified' : `failed: ${result.kyc.reason}`}</Chip>}
                      </div>
                    )}
                    {i === 2 && stage >= 2 && (
                      <div style={{ marginTop: 4 }}>
                        <div className="row">
                          <button onClick={eligibility} disabled={busy || stage !== 2}>Check eligibility (prescreen rules)</button>
                          {result.eligibility && <Chip tone={result.eligibility.decision === 'pass' ? 'good' : 'bad'}>{result.eligibility.decision}</Chip>}
                        </div>
                        {result.eligibility?.reasons && <Reasons reasons={result.eligibility.reasons} />}
                      </div>
                    )}
                    {i === 3 && stage >= 3 && (
                      <div style={{ marginTop: 4 }}>
                        <div className="row">
                          <button onClick={offer} disabled={busy || stage !== 3}>Get offer (mock bureau + credit rules)</button>
                          {result.offer && <Chip tone={result.offer.decision === 'approve' ? 'good' : result.offer.decision === 'refer' ? 'warn' : 'bad'}>{result.offer.decision}</Chip>}
                        </div>
                        {result.offer?.message && <p style={{ marginTop: 6 }}>{result.offer.message}</p>}
                        {result.offer?.reasons && <Reasons reasons={result.offer.reasons} />}
                      </div>
                    )}
                    {i === 4 && stage >= 4 && (
                      <div className="row" style={{ marginTop: 4 }}>
                        <button className="primary" onClick={accept} disabled={busy || stage !== 4}>Accept offer</button>
                        {result.accept && <Chip tone="good">{result.accept.status}{result.accept.amount ? ` · ${inr(result.accept.amount)}` : ''}</Chip>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {result.offer?.offer && <Card><Kfs offer={result.offer.offer} /></Card>}
        {result.accept?.cooling_off_days && <Notice kind="ok">Simulated disbursal. You can exit within the {result.accept.cooling_off_days}-day cooling-off period without penalty (demo policy). No money moved: this is synthetic.</Notice>}

        {events.length > 0 && (
          <Card title="Event trail" sub="What the analytics will see for this application">
            <div className="scroll"><table><tbody>{events.map((e, i) => <tr key={i}><td>{new Date(e.ts).toLocaleTimeString()}</td><td><code>{e.event_type}</code></td></tr>)}</tbody></table></div>
          </Card>
        )}
      </div>
    </div>
  );
}
