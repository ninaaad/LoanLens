import { useState } from 'react';
import { get, post } from '../lib.js';
import { Card, Notice, ErrorBox, Chip, useAsync } from '../ui.jsx';

const EXAMPLES = [
  'Can a borrower exit a digital loan during a cooling-off period without a penalty?',
  'Can a lending app access my contact list, call logs and photos?',
  'Where must the borrower\'s data be stored?',
  'What must regulated entities report to RBI about their digital lending apps?',
  'Who must be appointed to handle digital lending complaints?',
];

export default function Compliance() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [asked, setAsked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sources = useAsync(() => get('/api/compliance/sources'), []);

  const ask = async (text) => {
    const question = (text ?? q).trim();
    if (question.length < 3) { setError(new Error('Type a question of at least 3 characters.')); return; }
    setBusy(true); setError(null);
    try { setRes(await post('/api/compliance/ask', { question })); setAsked(question); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const notice = res?.notice ?? sources.data?.notice;

  return (
    <div className="stack">
      <Card title="Compliance assistant" sub="Answers are quotes from the RBI Digital Lending Directions with clause citations. Nothing is paraphrased or invented, and an LLM is never used to decide whether something is allowed.">
        <form className="row" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about KFS, cooling-off, consent, data storage, grievance, DLA reporting…" aria-label="Question" maxLength={500} />
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Searching…' : 'Ask'}</button>
        </form>
        <div className="row" style={{ marginTop: 8 }}>
          {EXAMPLES.map((e) => <button key={e} className="link" onClick={() => { setQ(e); ask(e); }}>{e}</button>)}
        </div>
        <div style={{ marginTop: 10 }}><ErrorBox error={error} /></div>
      </Card>

      {res && (
        <Card title={res.found ? 'Answer' : 'Not found'} sub={asked} live>
          {res.found ? (
            <div className="stack">
              {res.citations.map((c, i) => (
                <div key={c.label}>
                  <div className="row"><Chip tone="good">{c.label}</Chip><strong>{c.heading}</strong><span className="sub">{c.chapter}</span>{i === 0 && <Chip>best match</Chip>}</div>
                  <div className="quote">“{c.quote}”</div>
                </div>
              ))}
              <div className="sub">Extractive answer: the text above is copied from the Directions. Match scores: {res.citations.map((c) => c.rank.toFixed(2)).join(', ')}.</div>
            </div>
          ) : <p>{res.answer}</p>}
        </Card>
      )}

      <Notice>{notice ?? 'Source: RBI Digital Lending Directions, 2025. The PDF is stamped "Withdrawn"; verify the currently applicable instruction. Not legal advice.'}</Notice>

      {sources.data && (
        <Card title="What is in the corpus" sub={`${sources.data.title} · ${sources.data.doc_id} · ${sources.data.chunks} passages · status in PDF: ${sources.data.status_in_pdf}`}>
          <div className="row">{sources.data.clauses.map((c) => <Chip key={c.clause}>{c.clause}: {c.heading}</Chip>)}</div>
        </Card>
      )}
    </div>
  );
}
