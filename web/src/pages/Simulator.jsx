import { useEffect, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, BarChart } from 'recharts';
import { get, post, pct, pts, int, inr, buildCandidate } from '../lib.js';
import { Card, Async, useAsync, Field, Notice, ErrorBox, Stat } from '../ui.jsx';

const RULE_FIELDS = [
  ['score_hard', 'Reject below bureau score', 1],
  ['score_soft', 'Refer below bureau score', 1],
  ['foir_hard', 'Reject above FOIR', 0.01],
  ['foir_soft', 'Refer above FOIR', 0.01],
  ['income_min', 'Minimum monthly income (₹)', 500],
];
const SEG = { device: 'Device', channel: 'Channel', employment: 'Employment', new_to_credit: 'New to credit' };

export default function Simulator() {
  const rules = useAsync(() => get('/api/rules'), []);
  const meta = useAsync(() => get('/api/meta'), []);
  return (
    <Async query={rules} what="rulesets">{(rs) => (
      <Async query={meta} what="dataset">{(m) => <SimBody rulesets={rs} range={m.range} />}</Async>
    )}</Async>
  );
}

function formFor(cfg) {
  return { rules: Object.fromEntries(RULE_FIELDS.map(([id]) => [id, cfg.rules.find((r) => r.id === id)?.value ?? ''])), maxLoanIncomeMultiple: cfg.maxLoanIncomeMultiple };
}

function SimBody({ rulesets, range }) {
  const latest = rulesets.at(-1).version;
  const [baseVersion, setBaseVersion] = useState(latest);
  const baseCfg = rulesets.find((r) => r.version === baseVersion).config;
  const [form, setForm] = useState(() => formFor(baseCfg));
  const [from, setFrom] = useState(range.first);
  const [to, setTo] = useState(range.last);
  const [seg, setSeg] = useState('device');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setForm(formFor(baseCfg)); setRes(null); }, [baseVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const candidate = buildCandidate(baseVersion, baseCfg, form);
      setRes(await post('/api/simulate', { baseline: baseVersion, candidate, from, to }));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const setRule = (id) => (e) => setForm({ ...form, rules: { ...form.rules, [id]: e.target.value } });
  const reset = () => { setForm(formFor(baseCfg)); setRes(null); };

  return (
    <div className="stack">
      <Card title="What-if simulator" sub="Replay stored applications through your edited ruleset and compare it with the baseline. Only the rules engine decides; nothing here calls an LLM.">
        <div className="grid g3">
          <Field label="Baseline ruleset">
            <select value={baseVersion} onChange={(e) => setBaseVersion(e.target.value)}>{rulesets.map((r) => <option key={r.version}>{r.version}</option>)}</select>
          </Field>
          <Field label="From"><input type="date" value={from} min={range.first} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} max={range.last} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
        </div>
        <h3 style={{ marginTop: 14 }}>Candidate thresholds</h3>
        <div className="grid g3">
          {RULE_FIELDS.map(([id, label, step]) => (
            <Field key={id} label={`${label}${baseCfg.rules.find((r) => r.id === id)?.value !== Number(form.rules[id]) ? ' (changed)' : ''}`}>
              <input type="number" step={step} value={form.rules[id]} onChange={setRule(id)} aria-label={label} />
            </Field>
          ))}
          <Field label="Max loan as multiple of monthly income">
            <input type="number" step="1" value={form.maxLoanIncomeMultiple} onChange={(e) => setForm({ ...form, maxLoanIncomeMultiple: e.target.value })} aria-label="Max loan multiple" />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run simulation'}</button>
          <button onClick={reset} disabled={busy}>Reset to {baseVersion}</button>
        </div>
        <div style={{ marginTop: 10 }}><ErrorBox error={error} /></div>
      </Card>

      {res && <Results res={res} seg={seg} setSeg={setSeg} />}
    </div>
  );
}

function Col({ title, r, base }) {
  const d = (k, fmt, goodWhenUp = true) => {
    if (!base) return null;
    const v = r[k] - base[k];
    if (!Number.isFinite(v)) return null; // e.g. NPA is null when nothing is disbursed
    if (Math.abs(v) < 1e-9) return <span className="sub">no change</span>;
    return <span className={`delta ${(v > 0) === goodWhenUp ? 'good' : 'bad'}`}>{fmt(v)}</span>;
  };
  return (
    <Card title={title}>
      <div className="stack">
        <Stat label="Approve rate" value={pct(r.approve_rate)} sub={d('approve_rate', (v) => pts(v, 1))} />
        <Stat label="Expected disbursals" value={int(r.expected_disbursals)} sub={d('expected_disbursals', (v) => (v > 0 ? '+' : '') + int(v))} />
        <Stat label="Expected NPA (share of disbursed amount)" value={pct(r.expected_npa, 2)} sub={d('expected_npa', (v) => pts(v), false)} />
        <Stat label="Approved applicants who would default" value={int(r.approved_would_default)} sub={d('approved_would_default', (v) => (v > 0 ? '+' : '') + v, false)} />
        <div className="sub">Refer {pct(r.refer_rate)} · Reject {pct(r.reject_rate)} · Disbursed amount {inr(r.expected_disbursed_amount)}</div>
      </div>
    </Card>
  );
}

function Results({ res, seg, setSeg }) {
  const { baseline: b, candidate: c, delta } = res.results;
  const compare = [
    { name: res.baseline.version, disbursals: b.expected_disbursals, npa: b.expected_npa },
    { name: 'Candidate', disbursals: c.expected_disbursals, npa: c.expected_npa },
  ];
  const mix = [{ name: res.baseline.version, ...b }, { name: 'Candidate', ...c }].map((x) => ({ name: x.name, Approve: x.approve_rate, Refer: x.refer_rate, Reject: x.reject_rate }));
  return (
    <>
      <Notice>{res.notice}</Notice>
      <div className="sub">{int(res.population.applications)} applications that completed KYC between {res.window.from} and {res.window.to}. {res.caveats.join(' ')}</div>
      {res.backtest && <div className="sub">Backtest: the baseline expects {int(res.backtest.baseline_expected_disbursals)} disbursals; {int(res.backtest.actual_disbursed)} of these applicants actually disbursed ({int(res.backtest.actual_disbursed_from_referrals)} of them after a manual review, which the simulator does not count){res.backtest.ratio_expected_to_actual ? ` (ratio ${res.backtest.ratio_expected_to_actual.toFixed(2)})` : ''}. A ratio far from 1 means the acceptance model is rough.</div>}
      <div className="grid g3">
        <Col title={`Baseline (${res.baseline.version})`} r={b} />
        <Col title="Candidate" r={c} base={b} />
        <Card title="Change">
          <div className="stack">
            <Stat label="Approvals" value={`${delta.approve > 0 ? '+' : ''}${int(delta.approve)}`} />
            <Stat label="Referrals" value={`${delta.refer > 0 ? '+' : ''}${int(delta.refer)}`} />
            <Stat label="Rejections" value={`${delta.reject > 0 ? '+' : ''}${int(delta.reject)}`} />
            <Stat label="Expected disbursed amount" value={`${delta.expected_disbursed_amount >= 0 ? '+' : '-'}${inr(Math.abs(delta.expected_disbursed_amount))}`} />
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Conversion versus risk" sub="Bars: expected disbursals. Line: expected NPA.">
          <div className="chartbox" role="img" aria-label="Expected disbursals and expected NPA, baseline versus candidate">
            <ResponsiveContainer>
              <ComposedChart data={compare}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="var(--muted)" fontSize={12} />
                <YAxis yAxisId="l" stroke="var(--muted)" fontSize={12} width={48} />
                <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => pct(v, 2)} stroke="var(--muted)" fontSize={12} width={56} domain={[0, 'auto']} />
                <Tooltip formatter={(v, n) => (n === 'Expected NPA' ? pct(v, 2) : int(v))} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                <Legend />
                <Bar yAxisId="l" dataKey="disbursals" name="Expected disbursals" fill="var(--c1)" />
                <Line yAxisId="r" dataKey="npa" name="Expected NPA" stroke="var(--bad)" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Decision mix">
          <div className="chartbox" role="img" aria-label="Approve, refer and reject shares">
            <ResponsiveContainer>
              <BarChart data={mix} layout="vertical" stackOffset="expand" margin={{ left: 16 }}>
                <XAxis type="number" tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="var(--muted)" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="var(--muted)" fontSize={12} width={72} />
                <Tooltip formatter={(v) => pct(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                <Legend />
                <Bar dataKey="Approve" stackId="a" fill="var(--c2)" /><Bar dataKey="Refer" stackId="a" fill="var(--c3)" /><Bar dataKey="Reject" stackId="a" fill="var(--c6)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="By segment" actions={<select aria-label="Segment" value={seg} onChange={(e) => setSeg(e.target.value)}>{Object.entries(SEG).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}>
        <div className="scroll">
          <table>
            <thead><tr><th>{SEG[seg]}</th><th className="num">Applicants</th><th className="num">Approve rate</th><th className="num">Change</th><th className="num">Expected NPA</th><th className="num">Change</th><th className="num">Disbursals</th></tr></thead>
            <tbody>{res.segments[seg].map((s) => (
              <tr key={s.value}>
                <td>{s.value}</td><td className="num">{int(s.applications)}</td>
                <td className="num">{pct(s.baseline.approve_rate)} → {pct(s.candidate.approve_rate)}</td><td className="num">{pts(s.delta.approve_rate, 1)}</td>
                <td className="num">{pct(s.baseline.expected_npa, 2)} → {pct(s.candidate.expected_npa, 2)}</td><td className="num">{pts(s.delta.expected_npa)}</td>
                <td className="num">{int(s.baseline.expected_disbursals)} → {int(s.candidate.expected_disbursals)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <Card title="Top reason codes">
        <div className="grid g2">
          {[['Baseline', b], ['Candidate', c]].map(([n, r]) => (
            <div className="scroll" key={n}><table><thead><tr><th>{n}</th><th className="num">Applicants</th></tr></thead>
              <tbody>{r.top_reasons.map((x) => <tr key={x.reason}><td><code>{x.reason}</code></td><td className="num">{int(x.count)}</td></tr>)}</tbody></table></div>
          ))}
        </div>
      </Card>
    </>
  );
}
