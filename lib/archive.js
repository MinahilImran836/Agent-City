// Searchable archive of everything the city has produced (agent answers, mission reports), so any shop can
// answer "what did you find last week?" (retrieval-augmented generation). Answers are split into chunks and
// ranked with BM25: no embeddings, no extra API, works offline. Stored in data/archive.json.
import fs from 'node:fs';
const FILE = 'data/archive.json', MAX_CHUNKS = 3000;
let db = { chunks: [], uid: 1 };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(db)), 500); };

const STOP = new Set('a an and are as at be by for from has have i in is it me my of on or our that the this to was were will with you your what which who how find show give get any all about into than then there these those do does did can could should would please'.split(' '));
const words = t => String(t).toLowerCase().match(/[a-z0-9+#.]{2,}/g)?.filter(w => !STOP.has(w)) || [];

// split markdown into ~700-char chunks along list items / paragraphs, so one chunk is roughly one job or paper
function chunks(text) {
  const parts = String(text).split(/\n(?=\s*(?:\d+[.)]|[-*]|#{1,4}|\|)\s)|\n\s*\n/), out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > 700) { out.push(cur.trim()); cur = ''; }
    cur += p + '\n';
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(c => c.length > 40).map(c => c.slice(0, 1200));
}

export function add({ agent, title, text }) {
  if (!text || /^⚠️|^Error/.test(text)) return;
  const at = new Date().toISOString().slice(0, 10);
  for (const c of chunks(text)) db.chunks.push({ id: db.uid++, agent, title: String(title || '').slice(0, 120), at, text: c });
  if (db.chunks.length > MAX_CHUNKS) db.chunks.splice(0, db.chunks.length - MAX_CHUNKS);
  save();
}

// BM25 over chunk text + title; optional agent filter; newer chunks win ties
export function search(query, { agent, k = 6, min = 0 } = {}) {
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  const pool = agent ? db.chunks.filter(c => c.agent === agent || c.agent === 'hall') : db.chunks;
  const docs = pool.map(c => words(c.title + ' ' + c.text)), N = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = Object.fromEntries(q.map(w => [w, docs.filter(d => d.includes(w)).length]));
  return pool.map((c, i) => {
    const d = docs[i]; let s = 0;
    for (const w of q) {
      const tf = d.filter(x => x === w).length; if (!tf) continue;
      s += Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    return { c, s: s + i * 1e-6 };
  }).filter(x => x.s > min).sort((a, b) => b.s - a.s).slice(0, k)
    .map(({ c }) => ({ from: c.agent, date: c.at, about: c.title, text: c.text }));
}
export const size = () => db.chunks.length;
