// Shared long-term memory: facts about the user that every agent sees (skills, location, goals, preferences).
// Stored in data/memory.json so the city keeps knowing you across restarts.
import fs from 'node:fs';
const FILE = 'data/memory.json';
let mem = { facts: [], uid: 1 };
try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(mem, null, 1));

export const facts = () => mem.facts;
export function remember(text) {
  text = String(text || '').trim().slice(0, 300);
  if (text.length < 3) return { error: 'Nothing to remember' };
  const low = text.toLowerCase();
  if (mem.facts.some(f => f.text.toLowerCase() === low)) return { ok: true, note: 'Already known' };
  mem.facts.push({ id: mem.uid++, text, at: new Date().toISOString().slice(0, 10) });
  if (mem.facts.length > 40) mem.facts.shift();
  save(); return { ok: true, remembered: text };
}
export function forget(id) { mem.facts = mem.facts.filter(f => f.id !== +id); save(); }
// short block for system prompts
export const profileText = () => mem.facts.length ? 'What you know about the user (from shared memory):\n' + mem.facts.map(f => '- ' + f.text).join('\n') : '';
