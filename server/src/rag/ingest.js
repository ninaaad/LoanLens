// Ingests the RBI Digital Lending Directions into rag_chunks (clause / paragraph chunks, Postgres FTS).
// Text comes from `pdftotext -layout` when available, otherwise from the npm `pdf-parse` package.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';

const run = promisify(execFile);

export const DOC = {
  id: 'RBI/2025-26/36',
  title: 'Reserve Bank of India (Digital Lending) Directions, 2025',
};

export async function extractText(pdfPath = config.rbiPdf) {
  if (!fs.existsSync(pdfPath)) throw new Error(`RBI PDF not found at ${pdfPath}`);
  try {
    const { stdout } = await run('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 32 * 1024 * 1024 });
    if (stdout.trim().length > 1000) return { text: stdout, extractor: 'pdftotext -layout' };
  } catch {
    /* pdftotext not installed: fall through to pdf-parse */
  }
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js'); // the package root runs a debug read on import
  const parsed = await pdfParse(fs.readFileSync(pdfPath));
  return { text: parsed.text, extractor: 'pdf-parse' };
}

// The PDF carries a diagonal "Withdrawn" watermark, which text extraction scatters as fragments
// ("n", "aw", "ithdr", ...) at the start of lines or on lines of their own.
const FRAG = 'Withdrawn|Withdraw|Withdra|Withd|ithdrawn|ithdraw|ithdra|ithdr|ithd|ith|awn|raw|aw|ra|wn|dr|W|w|n';
const WHOLE_LINE_WATERMARK = new RegExp(`^(?:${FRAG}|With)$`);
const LEADING_FRAGMENT = new RegExp(`^(?:${FRAG})\\s+(?=\\S)`);

// "With" is also a real word, so it is only stripped in front of a paragraph or heading marker ("With ii. The period ...")
const LEADING_WITH = /^With\s+(?=(?:[ivx]+\.|[a-h]\.|\d{1,2}\.|Chapter|Annex)\s)/;

export function cleanText(raw) {
  const out = [];
  for (const rawLine of raw.replace(/\f/g, '\n').replace(/\r/g, '').split('\n')) {
    let line = rawLine.replace(/�/g, '-').replace(/\s+$/, '');
    let t = line.trim();
    // strip watermark fragments glued to the start of real text (repeat: "ithd" then "W")
    for (let i = 0; i < 3 && (LEADING_FRAGMENT.test(t) || LEADING_WITH.test(t)); i++) t = t.replace(LEADING_FRAGMENT, '').replace(LEADING_WITH, '');
    if (!t) { out.push(''); continue; }
    if (WHOLE_LINE_WATERMARK.test(t)) continue;
    if (/^\d{1,2}$/.test(t)) continue; // bare page number
    out.push(t);
  }
  return out;
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];
const LONG_PARA = 1000; // characters: longer paragraphs with lettered items are split into one chunk per item

const joinLines = (lines) => lines.reduce((acc, l) => (acc.endsWith('-') && /^[a-z]/.test(l) ? acc + l : acc ? `${acc} ${l}` : l), '')
  .replace(/\s+/g, ' ').replace(/vis-.-vis/, 'vis-à-vis').trim();

/** Pure function: cleaned lines in, chunk objects out. */
export function chunkLines(lines) {
  // body starts at the real "Chapter I" heading, not the index entry (which has dot leaders)
  const start = lines.findIndex((l) => /^Chapter I: Preliminary$/.test(l));
  if (start < 0) throw new Error('could not find "Chapter I: Preliminary" in the extracted text');
  const chunks = [];
  let chapter = null;
  let clause = null; // { n, title, label }
  let nextClause = 1;
  let romanIdx = -1; // index into ROMAN of the last sub-paragraph seen in the current clause
  let para = null; // { label, lines, items: [{label, lines}] }
  let item = null;
  let inAnnex = false;
  let prevBlank = true;

  const flushPara = () => {
    if (!clause || !para) { para = null; item = null; return; }
    const text = joinLines(para.lines);
    const itemTexts = para.items.map((it) => ({ label: it.label, text: joinLines(it.lines) }));
    const total = text.length + itemTexts.reduce((a, i) => a + i.text.length, 0);
    const base = { doc_id: DOC.id, doc_title: DOC.title, chapter, clause: clause.label, heading: clause.title };
    if (itemTexts.length && total > LONG_PARA) {
      if (text) chunks.push({ ...base, para: para.label, content: text });
      for (const it of itemTexts) chunks.push({ ...base, para: `${para.label ?? ''}(${it.label})`, content: it.text });
    } else {
      const content = [text, ...itemTexts.map((i) => `${i.label}. ${i.text}`)].filter(Boolean).join(' ');
      if (content) chunks.push({ ...base, para: para.label, content });
    }
    para = null; item = null;
  };

  for (let idx = start; idx < lines.length; idx++) {
    const l = lines[idx];
    if (l === '') { prevBlank = true; continue; }
    const wasBlank = prevBlank;
    prevBlank = false;

    const ch = l.match(/^Chapter ([IVX]+): (.+)$/);
    if (ch) { flushPara(); chapter = `Chapter ${ch[1]}: ${ch[2]}`; continue; }

    const annex = l.match(/^Annex ([IVX]+):\s*(.+)$/);
    if (annex) {
      flushPara();
      inAnnex = true;
      chapter = `Annex ${annex[1]}`;
      clause = { n: null, label: `Annex ${annex[1]}`, title: annex[2].replace(/\s+/g, ' ') };
      para = { label: null, lines: [], items: [] };
      continue;
    }

    if (inAnnex) {
      const ill = l.match(/^Illustration (\d+)$/);
      if (ill) { flushPara(); para = { label: `Illustration ${ill[1]}`, lines: [], items: [] }; continue; }
      para ??= { label: null, lines: [], items: [] };
      para.lines.push(l);
      continue;
    }

    // numbered footnotes ("1 While entities ...") run to the next blank line; they are dropped, not part of any clause
    if (wasBlank && /^\d{1,2} \S/.test(l) && !/^\d{1,2}\. /.test(l)) {
      while (idx + 1 < lines.length && lines[idx + 1] !== '') idx++;
      continue;
    }

    const head = l.match(/^(\d{1,2})\.\s+(\S.*)$/);
    if (head && Number(head[1]) === nextClause && !/\.{4,}/.test(l)) {
      flushPara();
      clause = { n: nextClause, label: `Clause ${nextClause}`, title: head[2].trim() };
      nextClause += 1;
      romanIdx = -1;
      para = { label: null, lines: [], items: [] };
      continue;
    }
    if (!clause) continue;

    // sub-paragraphs: (i) (ii) ... in sequence, then (a) (b) ... in sequence inside a paragraph
    const rom = l.match(/^([ivx]+)\.\s+(.*)$/);
    if (rom && rom[1] === ROMAN[romanIdx + 1]) {
      flushPara();
      romanIdx += 1;
      para = { label: `(${rom[1]})`, lines: [rom[2]], items: [] };
      continue;
    }
    const let_ = l.match(/^([a-h])\.\s+(.*)$/);
    if (let_ && para) {
      const expected = String.fromCharCode('a'.charCodeAt(0) + para.items.length);
      if (let_[1] === expected) {
        item = { label: let_[1], lines: [let_[2]] };
        para.items.push(item);
        continue;
      }
    }
    para ??= { label: null, lines: [], items: [] };
    (item ?? para).lines.push(l);
  }
  flushPara();
  return chunks;
}

export async function ingest(pool, { pdfPath } = {}) {
  const { text, extractor } = await extractText(pdfPath);
  const chunks = chunkLines(cleanText(text));
  if (chunks.length < 50) throw new Error(`only ${chunks.length} chunks parsed; refusing to replace the stored corpus`);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from rag_chunks where doc_id = $1', [DOC.id]); // idempotent: replace, never append
    for (const c of chunks) {
      await client.query(
        'insert into rag_chunks (doc_id, doc_title, chapter, clause, para, heading, content) values ($1,$2,$3,$4,$5,$6,$7)',
        [c.doc_id, c.doc_title, c.chapter, c.clause, c.para, c.heading, c.content],
      );
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return { doc_id: DOC.id, chunks: chunks.length, extractor };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createDb } = await import('../db/connection.js');
  const { migrate } = await import('../db/migrate.js');
  const db = await createDb();
  try {
    await migrate(db.pool);
    console.log(await ingest(db.pool));
  } finally {
    await db.close();
  }
}
