import { useEffect, useState } from 'react';
import { get, post, ms, int } from '../lib.js';
import { Card, Notice, ErrorBox, Chip, Async, useAsync, Field } from '../ui.jsx';

const SCENARIO_LABEL = { normal: 'Back to normal', bureau_slowdown: 'Bureau slowdown', bureau_outage: 'Bureau outage', kyc_slowdown: 'KYC slowdown', kyc_outage: 'KYC outage' };

export default function MockControls() {
  const q = useAsync(() => get('/api/mock/status?minutes=15'), []);
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setInterval(() => q.reload(), 5000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scenario = async (name) => {
    setError(null);
    try { await post(`/api/mock/scenarios/${name}`); q.reload(); } catch (e) { setError(e); }
  };

  return (
    <div className="stack">
      <Notice>These control the <strong>mock</strong> credit bureau and KYC provider. Changes apply to journeys run afterwards and are held in server memory (a restart resets them). Journeys create synthetic applications in the same database the workbench reads.</Notice>
      <ErrorBox error={error} />
      <Async query={q} what="mock status">{(s) => (
        <>
          <Card title="Incident scenarios" sub="Switch one on, then run journeys from the Journey page or with the load script, and watch the recorded rows below.">
            <div className="row">
              {Object.entries(s.scenarios).map(([k, desc]) => (
                <button key={k} className={k === 'normal' ? '' : 'danger'} onClick={() => scenario(k)} title={desc}>{SCENARIO_LABEL[k] ?? k}</button>
              ))}
            </div>
            <div className="stack" style={{ marginTop: 10 }}>
              {Object.entries(s.scenarios).map(([k, desc]) => <div key={k} className="sub"><strong>{SCENARIO_LABEL[k] ?? k}:</strong> {desc}</div>)}
            </div>
            <p style={{ marginTop: 10 }}>Generate load: <code>npm run live-load -- --n 200 --concurrency 4</code> (add <code>--scenario bureau_slowdown --from 50 --to 150</code> to inject mid-run).</p>
          </Card>
          <div className="grid g2">
            <Provider name="bureau" cfg={s.config.bureau} onSaved={q.reload} />
            <Provider name="kyc" cfg={s.config.kyc} onSaved={q.reload} />
          </div>
          <Card title="Recorded in the last 15 minutes" sub="From api_calls and applications; refreshes every 5 seconds">
            <div className="scroll"><table>
              <thead><tr><th>Provider</th><th className="num">Calls</th><th className="num">OK</th><th className="num">Timeouts</th><th className="num">Errors</th><th className="num">p50</th><th className="num">p95</th></tr></thead>
              <tbody>
                {s.recorded.providers.map((p) => (
                  <tr key={p.provider}><td>{p.provider}</td><td className="num">{p.calls}</td><td className="num">{p.ok}</td><td className="num">{p.timeouts}</td><td className="num">{p.errors}</td><td className="num">{ms(p.p50_ms)}</td><td className="num">{ms(p.p95_ms)}</td></tr>
                ))}
                {!s.recorded.providers.length && <tr><td colSpan="7">No provider calls in this window. Run a journey or the load script.</td></tr>}
              </tbody>
            </table></div>
            <div className="row" style={{ marginTop: 10 }}>
              <Chip>{int(s.recorded.applications)} applications</Chip>
              <Chip tone={s.recorded.bureau_unavailable_referrals ? 'warn' : ''}>{int(s.recorded.bureau_unavailable_referrals)} sent to manual review because the bureau was unavailable</Chip>
            </div>
          </Card>
        </>
      )}</Async>
    </div>
  );
}

function Provider({ name, cfg, onSaved }) {
  const [draft, setDraft] = useState(cfg);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(cfg), [JSON.stringify(cfg)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => { setDraft({ ...draft, [k]: v }); setSaved(false); };

  const apply = async () => {
    setError(null);
    try {
      const patch = { provider: name, multiplier: Number(draft.multiplier), errorRate: Number(draft.errorRate), timeoutRate: Number(draft.timeoutRate) };
      if (name === 'bureau') patch.forceScore = draft.forceScore === null || draft.forceScore === '' ? null : Number(draft.forceScore);
      else patch.forceVerified = draft.forceVerified === 'null' || draft.forceVerified === null ? null : draft.forceVerified === true || draft.forceVerified === 'true';
      await post('/api/mock/config', patch);
      setSaved(true); onSaved();
    } catch (e) { setError(e); }
  };

  return (
    <Card title={name === 'bureau' ? 'Credit bureau (mock)' : 'KYC provider (mock)'} sub={`Nominal latency ${cfg.baseMs} ms`}>
      <div className="stack">
        <Field label={`Latency multiplier: ${Number(draft.multiplier).toFixed(1)}x`}>
          <input type="range" min="0.5" max="10" step="0.5" value={draft.multiplier} onChange={(e) => set('multiplier', e.target.value)} aria-label={`${name} latency multiplier`} />
        </Field>
        <Field label={`Error rate: ${(draft.errorRate * 100).toFixed(1)}%`}>
          <input type="range" min="0" max="1" step="0.01" value={draft.errorRate} onChange={(e) => set('errorRate', e.target.value)} aria-label={`${name} error rate`} />
        </Field>
        <Field label={`Timeout rate: ${(draft.timeoutRate * 100).toFixed(1)}%`}>
          <input type="range" min="0" max="1" step="0.01" value={draft.timeoutRate} onChange={(e) => set('timeoutRate', e.target.value)} aria-label={`${name} timeout rate`} />
        </Field>
        {name === 'bureau' ? (
          <Field label="Force a credit score (empty = realistic scores)">
            <input type="number" min="300" max="900" placeholder="e.g. 780" value={draft.forceScore ?? ''} onChange={(e) => set('forceScore', e.target.value === '' ? null : e.target.value)} aria-label="Forced credit score" />
          </Field>
        ) : (
          <Field label="Identity check result">
            <select value={String(draft.forceVerified)} onChange={(e) => set('forceVerified', e.target.value)} aria-label="Forced KYC result">
              <option value="null">Realistic (about 96% verify)</option><option value="true">Always verified</option><option value="false">Always fails</option>
            </select>
          </Field>
        )}
        <div className="row"><button className="primary" onClick={apply}>Apply</button>{saved && <Chip tone="good">applied</Chip>}</div>
        <ErrorBox error={error} />
      </div>
    </Card>
  );
}
