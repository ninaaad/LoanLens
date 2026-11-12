import { useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Scatter, Legend } from 'recharts';
import { get, pct, pts, signed, shortDay, routeHref, STEP_LABEL } from '../lib.js';
import { Card, Async, useAsync, Chip, Notice } from '../ui.jsx';

export default function Anomalies() {
  const q = useAsync(() => get('/api/anomalies'), []);
  const [step, setStep] = useState('offer_viewed');
  return (
    <Async query={q} what="anomalies">{(d) => {
      const series = d.series?.[step] ?? [];
      return (
        <div className="stack">
          <Card title="Flagged days" sub={`A day is flagged when its step conversion is at least ${d.config.zThreshold} robust deviations below a ${d.config.window}-day rolling baseline and at least ${(d.config.minDrop * 100).toFixed(0)} points lower.`}>
            <Notice>A statistical flag is a prompt to investigate, not proof of an incident. Some flags are chance: with many days and steps checked, a few will appear by luck. Open the RCA to see what, if anything, explains a flag.</Notice>
            <div className="scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Day</th><th>Step</th><th className="num">Rate</th><th className="num">Baseline</th><th className="num">Drop</th><th className="num">z</th><th className="num">Applicants</th><th /></tr></thead>
                <tbody>
                  {d.anomalies.map((a) => (
                    <tr key={`${a.day}${a.step}`}>
                      <td>{a.day}</td><td>{a.label}</td><td className="num">{pct(a.rate)}</td><td className="num">{pct(a.baseline)}</td>
                      <td className="num"><Chip tone="bad">{pts(-a.drop, 1)}</Chip></td><td className="num">{signed(a.z, 1)}</td><td className="num">{a.n}</td>
                      <td><a href={routeHref('workbench', 'rca', { day: a.day, step: a.step })}>Investigate →</a></td>
                    </tr>
                  ))}
                  {!d.anomalies.length && <tr><td colSpan="8">No days flagged.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          {d.shifts && (
            <Card title="Sustained shifts" sub={`A lasting step change too shallow for any single day to stand out: the last ${d.shift_config.windowDays} days pooled are at least ${d.shift_config.zThreshold} deviations below the ${d.shift_config.baselineDays} days before them and at least ${d.shift_config.minDrop * 100} points lower. Episodes are merged.`}>
              <div className="scroll">
                <table>
                  <thead><tr><th>Step</th><th>Window</th><th className="num">Rate</th><th className="num">Before</th><th className="num">Drop</th><th className="num">z</th><th></th></tr></thead>
                  <tbody>
                    {d.shifts.map((x) => (
                      <tr key={`${x.step}${x.from}`}>
                        <td>{x.label}</td><td>{x.from} to {x.to}</td><td className="num">{pct(x.rate)}</td><td className="num">{pct(x.baseline)}</td>
                        <td className="num"><Chip tone="warn">{pts(-x.drop, 1)}</Chip></td><td className="num">{signed(x.z, 1)}</td>
                        <td><a href={routeHref('workbench', 'rca', { day: x.from, step: x.step })}>Investigate →</a></td>
                      </tr>
                    ))}
                    {!d.shifts.length && <tr><td colSpan="7">No sustained shifts.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card
            title="Conversion against its baseline"
            sub="Red dots are flagged days."
            actions={<select aria-label="Step" value={step} onChange={(e) => setStep(e.target.value)}>{Object.keys(d.series).map((s) => <option key={s} value={s}>{STEP_LABEL[s]}</option>)}</select>}
          >
            <div className="chartbox" role="img" aria-label="Step conversion with rolling baseline and flagged days">
              <ResponsiveContainer>
                <ComposedChart data={series.map((p) => ({ ...p, flag: p.flagged ? p.rate : null }))}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--muted)" fontSize={12} minTickGap={24} />
                  <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="var(--muted)" fontSize={12} width={44} domain={['auto', 'auto']} />
                  <Tooltip formatter={(v, n) => [pct(v), n]} labelFormatter={shortDay} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                  <Legend />
                  <Line dataKey="baseline" name="Baseline" stroke="var(--c6)" strokeDasharray="5 4" dot={false} connectNulls />
                  <Line dataKey="rate" name="Conversion" stroke="var(--c1)" strokeWidth={2} dot={false} />
                  <Scatter dataKey="flag" name="Flagged" fill="var(--bad)" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      );
    }}</Async>
  );
}
