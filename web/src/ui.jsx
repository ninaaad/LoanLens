import { useEffect, useRef, useState } from 'react';

/** Run an async loader and track loading / error / data. Re-runs when deps change. */
export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const seq = useRef(0);
  const reload = () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve().then(fn).then(
      (data) => { if (mine === seq.current) setState({ loading: false, error: null, data }); },
      (error) => { if (mine === seq.current) setState({ loading: false, error, data: null }); },
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); return () => { seq.current += 1; }; }, deps);
  return { ...state, reload };
}

export function Card({ title, sub, actions, children, className = '', live = false }) {
  return (
    <section className={`card ${className}`} aria-live={live ? 'polite' : undefined}>
      {(title || actions) && (
        <div className="row spread" style={{ marginBottom: 8 }}>
          <div>
            {title && <h2 style={{ marginBottom: 0 }}>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const Notice = ({ children, kind = '' }) => <div className={`notice ${kind}`} role={kind === 'err' ? 'alert' : undefined}>{children}</div>;
export const ErrorBox = ({ error }) => (error ? <Notice kind="err">{error.message ?? String(error)}</Notice> : null);
export const Loading = ({ what = 'data' }) => <div className="skeleton">Loading {what}…</div>;

/** Wrap an async query: shows loading and errors, renders children(data) on success. */
export function Async({ query, what, children }) {
  if (query.loading && !query.data) return <Loading what={what} />;
  if (query.error) return <ErrorBox error={query.error} />;
  return query.data ? children(query.data) : null;
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <span className={`v ${tone ?? ''}`}>{value}</span>
      <span className="l">{label}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export const Chip = ({ tone = '', children }) => <span className={`chip ${tone}`}>{children}</span>;

export function ScoreBar({ value, label }) {
  const w = Math.max(0, Math.min(1, value ?? 0)) * 100;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)}>
      <div className="bar"><i style={{ width: `${w}%` }} /></div>
    </div>
  );
}

export function Field({ label, children }) {
  return <label className="f">{label}{children}</label>;
}

/** Minimal markdown for the generated experiment brief: headings, bullets, tables, quotes, **bold**, `code`. */
export function MiniMarkdown({ text }) {
  const inline = (s) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return p;
  });
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('# ')) out.push(<h3 key={i} className="md-title">{inline(l.slice(2))}</h3>); // the page already has its h1
    else if (l.startsWith('## ')) out.push(<h2 key={i}>{inline(l.slice(3))}</h2>);
    else if (l.startsWith('> ')) out.push(<blockquote key={i}>{inline(l.slice(2))}</blockquote>);
    else if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
      i--;
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(
        <div className="scroll" key={`t${i}`}>
          <table>
            <thead><tr>{cells(head).map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r, k) => <tr key={k}>{cells(r).map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (l.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) { items.push(lines[i].slice(2)); i++; }
      i--;
      out.push(<ul key={`u${i}`}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
    } else if (l.trim()) out.push(<p key={i}>{inline(l)}</p>);
  }
  return <div className="md">{out}</div>;
}
