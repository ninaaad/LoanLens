import { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ReferenceLine, BarChart, Bar } from 'recharts';
import { get, pct, int, hours, istDay, shortDay, fillDays, STEP_LABEL } from '../lib.js';
import { Card, Async, useAsync, Field, Stat, Notice } from '../ui.jsx';

const CONV_STEPS = ['kyc_completed', 'eligibility_passed', 'offer_viewed', 'offer_accepted', 'loan_disbursed'];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
const SEGMENT_LABEL = { device: 'Device', channel: 'Channel', employment: 'Employment', new_to_credit: 'New to credit', app_version: 'App version' };

export default function Funnel() {
  const meta = useAsync(() => get('/api/meta'), []);
  return <Async query={meta} what="dataset">{(m) => <FunnelBody meta={m} />}</Async>;
}

function FunnelBody({ meta }) {
  const [from, setFrom] = useState(meta.range.first);
  const [to, setTo] = useState(meta.range.last);
  const [segment, setSegment] = useState('');
  const [value, setValue] = useState('');
  const [view, setView] = useState('device');
  const [hidden, setHidden] = useState({});

  const all = useAsync(() => get(`/api/funnel?from=${from}&to=${to}`), [from, to]);
  const filtered = useAsync(
    () => (segment && value ? get(`/api/funnel?from=${from}&to=${to}&segment=${segment}&value=${encodeURIComponent(value)}`) : Promise.resolve(null)),
    [from, to, segment, value],
  );

  const options = useMemo(() => (all.data && segment ? all.data.segments[segment].map((s) => s.value) : []), [all.data, segment]);
  const f = segment && value && filtered.data ? filtered.data : all.data;

  // markers: releases and policy changes inside the window
  const markers = useMemo(() => {
    const inRange = (d) => d >= from && d <= to;
    return [
      ...meta.releases.map((r) => ({ day: istDay(r.deployed_at), label: r.version, kind: 'release' })),
      ...meta.rules.filter((r) => r.version !== 'v1').map((r) => ({ day: istDay(r.effective_from), label: `rules ${r.version}`, kind: 'rule' })),
    ].filter((m) => inRange(m.day));
  }, [meta, from, to]);

  return (
    <div className="stack">
      <Card title="Daily funnel" sub="Conversion into each step from the step before it. Dashed lines mark releases (amber) and credit-policy changes (purple).">
        <div className="row" style={{ marginBottom: 10 }}>
          <Field label="From"><input type="date" value={from} min={meta.range.first} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} max={meta.range.last} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
          <Field label="Filter by">
            <select value={segment} onChange={(e) => { setSegment(e.target.value); setValue(''); }}>
              <option value="">All applicants</option>
              {Object.entries(SEGMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {segment && (
            <Field label="Value">
              <select value={value} onChange={(e) => setValue(e.target.value)}><option value="">choose…</option>{options.map((o) => <option key={o}>{o}</option>)}</select>
            </Field>
          )}
        </div>
        <Async query={all} what="funnel">{() => f && (
          <>
            <div className="grid g4" style={{ marginBottom: 12 }}>
              <Stat label="Applications" value={int(f.total.counts.application_started)} />
              <Stat label="Disbursed" value={int(f.total.counts.loan_disbursed)} />
              <Stat label="Overall conversion" value={pct(f.total.conversion.overall)} />
              <Stat label="Median time to disburse" value={hours(f.total.median_tat_seconds)} />
            </div>
            <div className="chartbox tall" role="img" aria-label="Daily step conversion lines with release and rule-change markers">
              <ResponsiveContainer>
                <LineChart data={fillDays(f.days).map((d) => ({ day: d.day, ...Object.fromEntries(CONV_STEPS.map((s) => [s, d.conversion[s]])) }))} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--muted)" fontSize={12} minTickGap={24} />
                  <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0, 1]} stroke="var(--muted)" fontSize={12} width={44} />
                  <Tooltip formatter={(v, n) => [pct(v), STEP_LABEL[n] ?? n]} labelFormatter={shortDay} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                  <Legend formatter={(n) => STEP_LABEL[n] ?? n} onClick={(e) => setHidden((h) => ({ ...h, [e.dataKey]: !h[e.dataKey] }))} />
                  {markers.map((m, i) => (
                    <ReferenceLine key={`${m.kind}${m.label}`} x={m.day} stroke={m.kind === 'rule' ? 'var(--c4)' : 'var(--c3)'} strokeDasharray="4 3" label={{ value: m.label, position: 'insideTopRight', fontSize: 11, fill: 'var(--muted)', dy: (i % 3) * 14 }} />
                  ))}
                  {CONV_STEPS.map((s, i) => <Line key={s} dataKey={s} stroke={COLORS[i]} dot={false} strokeWidth={2} hide={!!hidden[s]} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="legend-note">Click a legend entry to hide or show a line.</div>
          </>
        )}</Async>
      </Card>

      <div className="grid g2">
        <Card title="Where applicants leave" sub="Counts reaching each step in the selected window">
          {f && <FunnelBars f={f} />}
        </Card>
        <Card title="Applications per day">
          {f && (
            <div className="chartbox" role="img" aria-label="Applications and disbursals per day">
              <ResponsiveContainer>
                <BarChart data={fillDays(f.days).map((d) => ({ day: d.day, started: d.counts.application_started ?? 0, disbursed: d.counts.loan_disbursed ?? 0 }))}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--muted)" fontSize={12} minTickGap={24} />
                  <YAxis stroke="var(--muted)" fontSize={12} width={40} />
                  <Tooltip labelFormatter={shortDay} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                  <Legend />
                  <Bar dataKey="started" name="Started" fill="var(--c6)" />
                  <Bar dataKey="disbursed" name="Disbursed" fill="var(--c2)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Segment breakdown"
        actions={<select aria-label="Segment" value={view} onChange={(e) => setView(e.target.value)}>{Object.entries(SEGMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
      >
        {all.data?.segments ? <SegmentTable rows={all.data.segments[view]} /> : <Notice>Loading…</Notice>}
      </Card>
    </div>
  );
}

function FunnelBars({ f }) {
  const steps = Object.keys(STEP_LABEL);
  const top = f.total.counts.application_started || 1;
  return (
    <div className="stack">
      {steps.map((s, i) => {
        const n = f.total.counts[s];
        const prev = i ? f.total.counts[steps[i - 1]] : null;
        return (
          <div key={s}>
            <div className="row spread"><span>{STEP_LABEL[s]}</span><span className="sub">{int(n)}{prev ? ` · ${pct(prev ? n / prev : null)} of previous` : ''}</span></div>
            <div className="bar"><i style={{ width: `${(n / top) * 100}%` }} /></div>
          </div>
        );
      })}
      <div className="sub">Rejected: {int(f.total.rejected)} · Sent to manual review: {int(f.total.referred)}</div>
    </div>
  );
}

function SegmentTable({ rows }) {
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>Value</th><th className="num">Started</th>{CONV_STEPS.map((s) => <th key={s} className="num">{STEP_LABEL[s]}</th>)}<th className="num">Overall</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.value}>
            <td>{r.value}</td><td className="num">{int(r.counts.application_started)}</td>
            {CONV_STEPS.map((s) => <td key={s} className="num">{pct(r.conversion[s])}</td>)}
            <td className="num">{pct(r.conversion.overall)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
