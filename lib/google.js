// Minimal Google OAuth + Gmail + Calendar over plain REST (no SDK, no cost).
import fs from 'node:fs';
const FILE = 'data/google.json', TZ = () => process.env.TZ_NAME || 'Asia/Karachi';
const cfg = () => ({ id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT || `http://localhost:${process.env.PORT || 3001}/oauth2callback` });
let tok = null; try { tok = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
export const configured = () => !!(cfg().id && cfg().secret);
export const connected = () => !!tok?.refresh_token;

export const authUrl = redirect => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: cfg().id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
  scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets',
});
async function tokenCall(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg().id, client_secret: cfg().secret, ...params }) });
  const j = await r.json(); if (!r.ok) throw new Error('Google auth: ' + (j.error_description || j.error)); return j;
}
export async function handleCallback(code, redirect) {
  const j = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirect });
  tok = { refresh_token: j.refresh_token || tok?.refresh_token, access: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  fs.writeFileSync(FILE, JSON.stringify(tok));
}
async function access() {
  if (tok.access && tok.exp > Date.now() + 60000) return tok.access;
  const j = await tokenCall({ refresh_token: tok.refresh_token, grant_type: 'refresh_token' });
  tok.access = j.access_token; tok.exp = Date.now() + j.expires_in * 1000; fs.writeFileSync(FILE, JSON.stringify(tok)); return tok.access;
}
async function g(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + await access(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    const t = await r.text();
    let msg = t; try { msg = JSON.parse(t).error?.message || t; } catch {}
    // e.g. "Gmail API has not been used in project N before or it is disabled. Enable it by visiting https://console..." -> keep the link
    if (r.status === 403 && /has not been used|disabled/i.test(msg)) throw new Error(`Google API switched off: ${msg.slice(0, 400)} Tell the user to open that link, click Enable, wait a minute and try again.`);
    if (r.status === 403 && /insufficient|scope|PERMISSION_DENIED/i.test(msg))
      throw new Error('Google permission missing: the user must click the Google button to reconnect and tick all permission boxes. Details: ' + msg.slice(0, 200));
    throw new Error(`Google ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}
// local time in TZ -> real ISO instant
function offsetMin(d) {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
  return (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - d.getTime()) / 60000;
}
export function toISO(s, endOfDay) {
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s) && s.length > 10) return new Date(s).toISOString();
  const guess = new Date((s.length <= 10 ? s + (endOfDay ? 'T23:59:59' : 'T00:00:00') : s) + 'Z');
  return new Date(guess.getTime() - offsetMin(guess) * 60000).toISOString();
}
// ---- Calendar ----
export async function listEvents({ from, to, q }) {
  const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '25', timeMin: toISO(from), timeMax: toISO(to, true) });
  if (q) p.set('q', q);
  const j = await g('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + p);
  return j.items.map(e => ({ id: e.id, title: e.summary, start: e.start.dateTime || e.start.date, end: e.end?.dateTime || e.end?.date, where: e.location, notes: (e.description || '').slice(0, 200) }));
}
export async function createEvent({ title, start, end, description, location, attendees }) {
  const body = { summary: title, description, location };
  if (start.length <= 10) {
    const next = new Date(new Date(start + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
    body.start = { date: start }; body.end = { date: end && end.length <= 10 && end > start ? end : next };
  } else {
    const s = toISO(start); body.start = { dateTime: s, timeZone: TZ() };
    body.end = { dateTime: end ? toISO(end) : new Date(new Date(s).getTime() + 36e5).toISOString(), timeZone: TZ() };
  }
  if (attendees?.length) body.attendees = attendees.map(email => ({ email }));
  const j = await g('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none', { method: 'POST', body: JSON.stringify(body) });
  return { ok: true, id: j.id, when: j.start.dateTime || j.start.date, link: j.htmlLink };
}
// ---- Gmail ----
export async function searchMail(q, max = 8) {
  const l = await g('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q, maxResults: String(max) }));
  return Promise.all((l.messages || []).map(async m => {
    const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const h = Object.fromEntries(d.payload.headers.map(x => [x.name, x.value]));
    return { id: m.id, from: h.From, subject: h.Subject, date: h.Date, snippet: d.snippet };
  }));
}
export async function readMail(id) {
  const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
  const find = (p, type) => p.mimeType === type && p.body?.data ? p.body.data : (p.parts || []).map(x => find(x, type)).find(Boolean);
  const data = find(d.payload, 'text/plain') || find(d.payload, 'text/html');
  const text = data ? Buffer.from(data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : d.snippet;
  const h = Object.fromEntries(d.payload.headers.map(x => [x.name, x.value]));
  return { from: h.From, subject: h.Subject, date: h.Date, body: text.slice(0, 3000) };
}
export async function sendMail({ to, subject, body }) {
  const clean = s => String(s).replace(/[\r\n]+/g, ' ');
  const raw = Buffer.from(`To: ${clean(to)}\r\nSubject: =?UTF-8?B?${Buffer.from(clean(subject)).toString('base64')}?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`).toString('base64url');
  return g('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
}

export async function myAddress() { return (await g('https://gmail.googleapis.com/gmail/v1/users/me/profile')).emailAddress; }
// ---- Sheets: we remember the sheets we create/link in data/sheets.json (no Drive permission needed) ----
const SF = 'data/sheets.json'; let reg = { sheets: {}, last: null }; try { reg = JSON.parse(fs.readFileSync(SF, 'utf8')); } catch {}
const rsave = () => fs.writeFileSync(SF, JSON.stringify(reg));
const sid = u => (String(u).match(/\/d\/([\w-]+)/) || [])[1] || String(u);
const remember = e => { reg.sheets[e.id] = e; reg.last = e.id; rsave(); };
function pick(ref) {
  if (!ref) { if (reg.sheets[reg.last]) return reg.sheets[reg.last]; throw new Error('No sheet yet. Create one with sheets_create or link one with sheets_link.'); }
  const q = String(ref).toLowerCase(), all = Object.values(reg.sheets);
  const hit = all.find(s => s.title.toLowerCase() === q || s.id === sid(ref)) || all.find(s => s.title.toLowerCase().includes(q));
  if (hit) return hit;
  throw new Error(`Unknown sheet "${ref}". Known sheets: ${all.map(s => s.title).join(', ') || 'none'}`);
}
export const sheetList = () => ({ lastUsed: reg.sheets[reg.last]?.title || null, sheets: Object.values(reg.sheets).map(s => ({ name: s.title, url: s.url })) });
export async function sheetCreate({ title, headers }) {
  const j = await g('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', body: JSON.stringify({ properties: { title } }) });
  const e = { id: j.spreadsheetId, url: j.spreadsheetUrl, title };
  if (headers?.length) await g(`https://sheets.googleapis.com/v4/spreadsheets/${e.id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values: [headers] }) });
  remember(e); return { ok: true, name: title, url: e.url };
}
export async function sheetLink({ url, name }) {
  const id = sid(url), j = await g(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,spreadsheetUrl`);
  const e = { id, url: j.spreadsheetUrl, title: name || j.properties.title }; remember(e); return { ok: true, name: e.title, url: e.url };
}
export async function sheetAppend({ sheet, rows }) {
  const s = pick(sheet), values = (rows || []).slice(0, 200).map(r => (Array.isArray(r) ? r : Object.values(r)).map(c => String(c ?? '').slice(0, 500)));
  if (!values.length) throw new Error('No rows given');
  const j = await g(`https://sheets.googleapis.com/v4/spreadsheets/${s.id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values }) });
  reg.last = s.id; rsave();
  return { ok: true, sheet: s.title, url: s.url, rowsAdded: j.updates?.updatedRows ?? values.length };
}
export async function sheetRead({ sheet, range }) {
  const s = pick(sheet), j = await g(`https://sheets.googleapis.com/v4/spreadsheets/${s.id}/values/${encodeURIComponent(range || 'A1:J200')}`);
  reg.last = s.id; rsave();
  return { sheet: s.title, url: s.url, rows: (j.values || []).slice(0, 200) };
}