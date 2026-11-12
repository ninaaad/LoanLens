import { useEffect, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend, BarChart } from 'recharts';
import { get, pct, pts, ms, STEP_LABEL } from '../lib.js';
import { Card, Async, useAsync, Chip, Notice, ScoreBar, Field, ErrorBox } from '../ui.jsx';

const STEPS = Object.keys(STEP_LABEL).slice(1);
const TONE = { likely: 'bad', possible: 'warn', 'ruled out': 'good' };

export default function Rca({ params }) {
  const [day, setDay] = useState(params.day ?? '2026-10-13');
  const [step, setStep] = useState(STEPS.includes(params.step) ? params.step : 'offer_viewed');
  // follow links from the Anomalies tab
  useEffect(() => {
    if (params.day) setDay(params.day);
    if (STEPS.includes(params.step)) setStep(params.step);
  }, [params.day, params.step]);

  const q = useAsync(() => get(`/api/rca?day=${day}&step=${step}`), [day, step]);

  return (
    <div className="stack">
      <Card title="Root-cause analysis" sub="Pick a day and a step, or open one from the Anomalies tab.">
        <div className="row">
          <Field label="Day"><input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></Field>
          <Field label="Step">
            <select value={step} onChange={(e) => setStep(e.target.value)}>{STEPS.map((s) => <option key={s} value={s}>{STEP_LABEL[s]}</option>)}</select>
          </Field>
        </div>
      </Card>
      {q.error ? <ErrorBox error={q.error} /> : (
        <Async query={q} what="analysis">{(r) => <RcaResult r={r} />}</Async>
      )}
    </div>
  );
}

function Decomposition({ d }) {
  const keys = [['converted', 'Converted', 'var(--c2)'], ['abandoned', 'Abandoned', 'var(--c3)'], ['rejected', 'Rejected', 'var(--c6)'], ['sent_to_manual_review', 'Manual review', 'var(--c4)']];
  const data = [{ name: 'Baseline', ...d.baseline }, { name: 'This day', ...d.today }];
  return (
    <div className="chartbox" style={{ height: 150 }} role="img" aria-label="Where applicants went: baseline versus this day">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" stackOffset="expand" margin={{ left: 16 }}>
          <XAxis type="number" tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="var(--muted)" fontSize={12} />
          <YAxis type="category" dataKey="name" stroke="var(--muted)" fontSize={12} width={70} />
          <Tooltip formatter={(v) => pct(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
          <Legend />
          {keys.map(([k, l, c]) => <Bar key={k} dataKey={k} name={l} stackId="a" fill={c} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Timeline({ h }) {
  const thr = h.details?.threshold_ms;
  return (
    <div className="chartbox" style={{ height: 200 }} role="img" aria-label="Hourly p95 latency of the provider on this day">
      <ResponsiveContainer>
        <ComposedChart data={h.timeline}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="hour" tickFormatter={(v) => `${v}h`} stroke="var(--muted)" fontSize={12} />
          <YAxis yAxisId="l" stroke="var(--muted)" fontSize={12} width={48} tickFormatter={(v) => `${v / 1000}s`} />
          <YAxis yAxisId="r" orientation="right" stroke="var(--muted)" fontSize={12} width={32} />
          <Tooltip formatter={(v, n) => [n === 'p95' ? ms(v) : v, n]} labelFormatter={(v) => `${v}:00 IST`} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
          <Legend />
          <Bar yAxisId="l" dataKey="p95_ms" name="p95" fill="var(--c1)" />
          <Line yAxisId="r" dataKey="failed" name="failed calls" stroke="var(--bad)" dot={false} strokeWidth={2} />
          {thr && <ReferenceLine yAxisId="l" y={thr} stroke="var(--c3)" strokeDasharray="4 3" label={{ value: 'alert threshold', fontSize: 11, fill: 'var(--muted)', position: 'insideTopLeft' }} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function RcaResult({ r }) {
  const ranked = [...r.hypotheses].sort((a, b) => b.score - a.score);
  return (
    <>
      <Card title={`${r.label}: ${r.day}`} sub={`Conversion from "${r.from_step}"`}>
        <div className="grid g4">
          <div className="stat"><span className="v">{pct(r.observed.rate)}</span><span className="l">that day</span></div>
          <div className="stat"><span className="v">{pct(r.observed.baseline_rate)}</span><span className="l">baseline</span></div>
          <div className="stat"><span className="v">{pts(r.observed.rate - r.observed.baseline_rate, 1)}</span><span className="l">change</span></div>
          <div className="stat"><span className="v">{r.observed.lost_conversions}</span><span className="l">fewer conversions of {r.observed.applications}</span></div>
        </div>
        <h3 style={{ marginTop: 14 }}>Where the drop went</h3>
        <Decomposition d={r.decomposition} />
      </Card>

      <Card title="Ranked hypotheses" sub="Each score is the share of the drop that would disappear if only that cause were removed.">
        <div className="stack">
          {ranked.map((h, i) => (
            <div key={h.id} className={`hyp ${i === 0 && h.score > 0 ? 'top' : ''}`}>
              <div className="row spread">
                <strong>{i + 1}. {h.title}</strong>
                <span className="row"><Chip>{h.type}</Chip><Chip tone={TONE[h.verdict] ?? ''}>{h.verdict}</Chip><strong>{pct(h.score, 0)}</strong></span>
              </div>
              <ScoreBar value={h.score} label={`${h.title} score`} />
              <ul>{h.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>
              {h.timeline && h.score > 0 && <Timeline h={h} />}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Summary">
        <p>{r.narrative}</p>
        {r.observed.significant === false && <Notice>This day's change is within normal variation, so no cause is scored. Pick a day the Anomalies tab flagged to see a ranking.</Notice>}
        {r.narrative_mode === 'llm' && <p className="sub">Wording by an optional language model from the evidence above; every number was checked against it. The ranking is computed by the code, not the model.</p>}
        <Notice>{r.caveat}</Notice>
        {r.observed.baseline_rate && r.hypotheses.some((h) => h.id.startsWith('policy') && h.score > 0 && h.score < 0.5) && (
          <p className="sub" style={{ marginTop: 8 }}>Known limitation: within about 14 days after a policy change, the baseline partly overlaps the pre-change period, so a small policy score can appear for reasons unrelated to the policy.</p>
        )}
      </Card>
    </>
  );
}
