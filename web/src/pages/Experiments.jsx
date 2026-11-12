import { useState } from 'react';
import { get, post, pct, pts, hours } from '../lib.js';
import { Card, Async, useAsync, Notice, ErrorBox, Chip, Field, MiniMarkdown } from '../ui.jsx';

const DECISION = { ship: ['good', 'SHIP'], hold: ['warn', 'HOLD'], stop: ['bad', 'STOP'] };
const GSTATUS = { ok: 'good', uncertain: 'warn', breach: 'bad', no_data: '' };

export default function Experiments() {
  const list = useAsync(() => get('/api/experiments'), []);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState(null);

  const createDemo = async () => {
    setError(null);
    try { const r = await post('/api/experiments/demo'); setSel(r.key); list.reload(); } catch (e) { setError(e); }
  };

  return (
    <div className="stack">
      <Notice>Experiments run on a separate synthetic cohort with a seeded, known effect. They show the method (assignment, sample-ratio check, guardrails, decision rule); they say nothing about real borrowers.</Notice>
      <Async query={list} what="experiments">{(d) => {
        const active = d.experiments.find((e) => e.key === sel) ?? d.experiments[0];
        return (
          <>
            <Card title="Experiments" actions={<button onClick={createDemo}>{d.experiments.length ? 'Ensure demo experiment' : 'Create demo experiment'}</button>}>
              <ErrorBox error={error} />
              {!d.experiments.length ? <p>No experiments yet. Create the demo: “show the KFS summary above the Accept button”.</p> : (
                <div className="scroll"><table>
                  <thead><tr><th>Key</th><th>Name</th><th>Primary metric</th><th>Guardrails</th><th>Variants</th><th>Status</th><th className="num">Units</th><th /></tr></thead>
                  <tbody>{d.experiments.map((e) => (
                    <tr key={e.key}>
                      <td><code>{e.key}</code></td><td>{e.name}</td><td>{e.primary_metric}</td>
                      <td>{e.guardrails.map((g) => g.metric).join(', ')}</td><td>{e.variants.map((v) => `${v.name} ${v.weight}%`).join(' / ')}</td>
                      <td><Chip>{e.status}</Chip></td><td className="num">{e.units}</td>
                      <td><button className="link" onClick={() => setSel(e.key)}>{active?.key === e.key ? 'selected' : 'open'}</button></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
            {active && <Detail key={active.key} exp={active} onRun={list.reload} />}
          </>
        );
      }}</Async>
    </div>
  );
}

function Detail({ exp, onRun }) {
  const [effect, setEffect] = useState('2');
  const [defShift, setDefShift] = useState('0');
  const [drop, setDrop] = useState('0');
  const [n, setN] = useState('40000');
  const [seed, setSeed] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const analysis = useAsync(() => (exp.units ? get(`/api/experiments/${exp.key}/analysis`) : Promise.resolve(null)), [exp.key]);
  const brief = useAsync(() => (exp.units ? get(`/api/experiments/${exp.key}/brief`) : Promise.resolve(null)), [exp.key]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      await post(`/api/experiments/${exp.key}/run`, {
        n: Number(n), seed: Number(seed), true_effect: { acceptance: Number(effect) / 100, default: Number(defShift) / 100 }, drop_treatment_rate: Number(drop) / 100,
      });
      onRun(); analysis.reload(); brief.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <Card title={exp.name} sub={exp.hypothesis}>
        <h3>Simulate a cohort</h3>
        <div className="row">
          <Field label="Users"><input type="number" value={n} onChange={(e) => setN(e.target.value)} /></Field>
          <Field label="Seed"><input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} /></Field>
          <Field label="True acceptance effect (pts)"><input type="number" step="0.5" value={effect} onChange={(e) => setEffect(e.target.value)} /></Field>
          <Field label="True default-rate shift (pts)"><input type="number" step="0.5" value={defShift} onChange={(e) => setDefShift(e.target.value)} /></Field>
          <Field label="Lose % of treatment users (logging bug)"><input type="number" step="1" value={drop} onChange={(e) => setDrop(e.target.value)} /></Field>
          <button className="primary" onClick={run} disabled={busy}>{busy ? 'Generating…' : exp.units ? 'Regenerate and analyse' : 'Generate and analyse'}</button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>Try +2 pts for a ship, 0 for a hold, a +3 pt default shift for a guardrail stop, or 10% lost users for a sample-ratio failure.</div>
        <div style={{ marginTop: 8 }}><ErrorBox error={error} /></div>
      </Card>

      {!exp.units ? <Notice>No data yet. Generate a cohort to see the analysis and the decision brief.</Notice> : (
        <>
          <Async query={analysis} what="analysis">{(a) => a && <Analysis a={a} />}</Async>
          <Async query={brief} what="brief">{(b) => b && (
            <Card title="Decision brief" sub="Auto-drafted from the numbers (template, no LLM)" actions={<button onClick={() => navigator.clipboard?.writeText(b.markdown)}>Copy markdown</button>}>
              <MiniMarkdown text={b.markdown} />
            </Card>
          )}</Async>
        </>
      )}
    </>
  );
}

function Analysis({ a }) {
  const [tone, label] = DECISION[a.decision.action];
  const p = a.primary;
  return (
    <>
      <Card title="Result">
        <div className="row" style={{ marginBottom: 8 }}>
          <Chip tone={tone}><span style={{ fontSize: 15 }}>{label}</span></Chip>
          <span>{a.decision.reasons[0]}</span>
        </div>
        {a.decision.reasons.slice(1).map((r, i) => <div key={i} className="sub">• {r}</div>)}
        <h3 style={{ marginTop: 12 }}>Primary metric: {p.label}</h3>
        <div className="scroll"><table>
          <tbody>
            <tr><th>Control</th><td>{pct(p.control, 2)}</td><th>Treatment</th><td>{pct(p.treatment, 2)}</td></tr>
            <tr><th>Difference</th><td>{pts(p.diff)} ({p.relative_lift === null ? 'n/a' : pct(p.relative_lift)} relative)</td><th>95% CI</th><td>{pts(p.ci95[0])} to {pts(p.ci95[1])}</td></tr>
            <tr><th>p-value</th><td>{p.p_value === null ? 'n/a' : p.p_value.toFixed(4)} {p.significant ? <Chip tone="good">significant</Chip> : <Chip>not significant</Chip>}</td><th>Sample ratio</th><td>{a.srm.observed.join(' / ')} (expected {a.srm.expected.join(' / ')}), p = {a.srm.p < 0.0001 ? a.srm.p.toExponential(1) : a.srm.p.toFixed(3)} {a.srm.flagged ? <Chip tone="bad">mismatch</Chip> : <Chip tone="good">ok</Chip>}</td></tr>
            {p.mde80 ? <tr><th>Sensitivity</th><td colSpan="3">Detects a true difference of about {pts(p.mde80)} or more 80% of the time. A smaller real effect would usually go unseen, so “not significant” is not “no effect”.</td></tr> : null}
          </tbody>
        </table></div>
      </Card>
      <Card title="Guardrails" sub="ok: the 95% interval sits inside the tolerance · uncertain: it straddles it · breach: it is entirely beyond it">
        <div className="scroll"><table>
          <thead><tr><th>Guardrail</th><th className="num">Control</th><th className="num">Treatment</th><th className="num">Change</th><th>95% CI</th><th>Tolerance</th><th>Status</th></tr></thead>
          <tbody>{a.guardrails.map((g) => {
            const time = g.metric === 'median_tat';
            return (
              <tr key={g.metric}>
                <td>{g.label}</td>
                <td className="num">{time ? hours(g.control) : pct(g.control, 2)}</td><td className="num">{time ? hours(g.treatment) : pct(g.treatment, 2)}</td>
                <td className="num">{time ? pct(g.delta_relative) : pts(g.delta)}</td>
                <td>{time ? `${hours(g.ci95?.[0])} to ${hours(g.ci95?.[1])}` : `${pts(g.ci95?.[0])} to ${pts(g.ci95?.[1])}`}</td>
                <td>{g.tolerance.type === 'rel' ? `+${(g.tolerance.value * 100).toFixed(0)}%` : `+${(g.tolerance.value * 100).toFixed(2)} pts`}</td>
                <td><Chip tone={GSTATUS[g.status]}>{g.status}</Chip></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Card>
    </>
  );
}
