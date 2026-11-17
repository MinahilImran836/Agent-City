// Tool registry. An "agent" = a purpose prompt + a checklist of these tools.
// To give agents a new ability, add one tool(...) here and it appears in the New Agent dialog.
import * as G from './google.js';
import * as ARCHIVE from './archive.js';
const UA = 'Mozilla/5.0 (AgentCity)';
const cache = new Map();
const cached = async (key, ttl, fn) => { const c = cache.get(key); if (c && c.t > Date.now()) return c.v; const v = await fn(); cache.set(key, { v, t: Date.now() + ttl }); return v; };
const getJSON = async (url, opt = {}) => { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...opt.headers }, signal: AbortSignal.timeout(9000) }); if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`); return r.json(); };
const strip = h => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---- web ----
async function webSearch(q) {
  return cached('ws:' + q, 300000, async () => {
    if (process.env.TAVILY_API_KEY) {
      const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: q, max_results: 6, search_depth: 'basic' }), signal: AbortSignal.timeout(12000) });
      return (await r.json()).results.map(x => ({ title: x.title, url: x.url, snippet: x.content.slice(0, 300) }));
    }
    if (process.env.BRAVE_API_KEY) {
      const j = await getJSON('https://api.search.brave.com/res/v1/web/search?count=5&q=' + encodeURIComponent(q), { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY } });
      return j.web.results.map(x => ({ title: x.title, url: x.url, snippet: strip(x.description || '') }));
    }
    const h = await (await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })).text();
    const res = [...h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5).map(m => {
      let u = m[1]; const d = u.match(/uddg=([^&]+)/); if (d) u = decodeURIComponent(d[1]);
      return { title: strip(m[2]), url: u, snippet: strip(m[3]).slice(0, 300) };
    });
    // DuckDuckGo often answers servers with a bot check; fail loudly so the agent tells the user instead of guessing
    if (!res.length) throw new Error('Web search unavailable: the free keyless search is blocked right now. Ask the user to add a free TAVILY_API_KEY to .env (tavily.com, 1000 searches/month).');
    return res;
  });
}
const priv = h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1)/i.test(h) || /\.(local|internal)$/.test(h);
async function fetchUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol) || priv(url.hostname)) throw new Error('URL not allowed');
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  return strip(await r.text()).slice(0, 5000);
}
// ---- papers (OpenAlex + arXiv, both free, no key) ----
const abs = inv => { if (!inv) return ''; const a = []; for (const [w, ps] of Object.entries(inv)) for (const p of ps) a[p] = w; return a.join(' '); };
async function openalex(q, n, from) {
  const p = new URLSearchParams({ search: q, 'per-page': String(n), select: 'title,publication_year,cited_by_count,doi,id,authorships,primary_location,abstract_inverted_index' });
  if (from) p.set('filter', `from_publication_date:${from}-01-01`);
  if (process.env.CONTACT_EMAIL) p.set('mailto', process.env.CONTACT_EMAIL);
  const j = await getJSON('https://api.openalex.org/works?' + p);
  return j.results.map(w => ({ title: w.title, year: w.publication_year, cites: w.cited_by_count, authors: w.authorships.slice(0, 3).map(a => a.author.display_name).join(', '), venue: w.primary_location?.source?.display_name || '', link: w.doi || w.id, abstract: abs(w.abstract_inverted_index).slice(0, 650) }));
}
async function arxiv(q, n) {
  const x = await (await fetch(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${n}&sortBy=submittedDate&sortOrder=descending`, { signal: AbortSignal.timeout(10000) })).text();
  return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1], f = t => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    return { title: f('title'), year: f('published').slice(0, 4), authors: [...e.matchAll(/<name>(.*?)<\/name>/g)].slice(0, 3).map(a => a[1]).join(', '), venue: 'arXiv preprint', link: f('id'), abstract: f('summary').slice(0, 650) };
  });
}
// ---- jobs ----
// Pakistan: LinkedIn's public job search (the listings linkedin.com/jobs shows when logged out) + Rozee.pk's search
// page data. Remote: free remote-job APIs + Jooble. Indeed blocks automated requests (403), so it only gets a link.
// Requests are few and on demand (one search = a handful of page loads), like a person browsing.
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const getText = async url => { const r = await fetch(url, { headers: { 'User-Agent': BROWSER, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`); return r.text(); };
const unesc = t => String(t || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const PK_PLACE = /pakistan|lahore|karachi|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|gujranwala|hyderabad|abbottabad/i;
const STOP = new Set(['remote', 'job', 'jobs', 'developer', 'engineer', 'position', 'role', 'work', 'the', 'and', 'for', 'in', 'a', 'internship', 'internships', 'intern', 'junior', 'entry', 'level']);
const PK = /worldwide|anywhere|global|asia|pakistan|apac|south asia|any location|international/i;
const NOT_PK = /\b(usa|u\.s\.|us|united states|canada|uk|united kingdom|europe|eu|germany|australia|latam|north america|brazil|france|netherlands|spain|poland)\b/i;
const JUNIOR = /\b(intern|internship|trainee|entry.level|junior|jr\.?|new grad|graduate|fresher|associate)\b/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|director|head of|vp|manager|architect)\b/i;
const iso = d => { try { return (typeof d === 'number' ? new Date(d * 1000) : new Date(d)).toISOString().slice(0, 10); } catch { return ''; } };

async function linkedin(q, loc, level, remote) {
  const p = new URLSearchParams({ keywords: q, location: remote ? 'Worldwide' : loc || 'Pakistan', sortBy: 'DD', f_TPR: 'r2592000' });
  if (remote) p.set('f_WT', '2');
  if (level === 'internship') p.set('f_E', '1'); else if (level === 'entry') p.set('f_E', '1,2');
  const pages = await Promise.all([0, 10].map(start => getText(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}&start=${start}`).catch(e => { if (!start) throw e; return ''; })));
  return pages.join('').split('<li>').slice(1).map(c => {
    const f = re => unesc((c.match(re) || [])[1]);
    return { title: f(/base-search-card__title">([\s\S]*?)</), company: f(/base-search-card__subtitle">[\s\S]*?>([\s\S]*?)</), where: f(/job-search-card__location">([\s\S]*?)</),
      date: f(/datetime="([^"]+)"/), url: f(/base-card__full-link[^>]*href="([^"?]+)/), salary: f(/job-search-card__salary-info">([\s\S]*?)</) };
  }).filter(j => j.title && j.url);
}
// Rozee renders its results from a JSON blob (apResp = {...}) in the page; read it with a string-aware brace scan
function jsonAfter(h, marker) {
  const a = h.indexOf('{', h.indexOf(marker)); if (h.indexOf(marker) < 0 || a < 0) throw new Error('page layout changed');
  let d = 0, inStr = false;
  for (let i = a; i < h.length; i++) {
    const ch = h[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true; else if (ch === '{') d++; else if (ch === '}' && !--d) return JSON.parse(h.slice(a, i + 1));
  }
  throw new Error('page layout changed');
}
let rozeeCities = null;
async function rozee(q, loc) {
  const page = async (kw, city) => jsonAfter(await getText(`https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(kw)}${city ? '/fc/' + city : ''}`), 'apResp').response;
  let r = await page(q);
  rozeeCities ||= Object.fromEntries((r.cities || []).filter(c => /^\d+$/.test(c.cityID)).map(c => [c.city.toLowerCase(), c.cityID]));
  const city = loc && Object.entries(rozeeCities).find(([name]) => loc.toLowerCase().includes(name))?.[1];
  if (city) r = await page(q, city);
  return [...(r.jobs?.sponsored || []), ...(r.jobs?.basic || [])].map(j => ({ title: unesc(j.title), company: unesc(j.company_name || j.company), where: j.city || 'Pakistan',
    date: j.created_at, url: `https://www.rozee.pk/${j.permaLink}`, experience: j.experience_text, deadline: iso(j.applyBy), tags: [].concat(j.skills || []).slice(0, 5).join(',') }));
}
function remoteBoards(q, keys, run) {
  return [
    ...(process.env.JOOBLE_API_KEY ? [run('jooble', () => fetch(`https://jooble.org/api/${process.env.JOOBLE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: q + ' remote' }), signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error('Jooble ' + r.status); return r.json(); })
      .then(j => (j.jobs || []).map(x => ({ title: x.title, company: x.company, where: x.location || 'Remote', url: x.link, date: x.updated, salary: x.salary, tags: x.type || '' }))))] : []),
    run('remotive', () => getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keys.join(' ') || q)}&limit=40`).then(r => r.jobs.map(x => ({ title: x.title, company: x.company_name, where: x.candidate_required_location, url: x.url, date: x.publication_date, salary: x.salary, tags: (x.tags || []).join(',') })))),
    ...keys.slice(0, 2).map(k => run('jobicy:' + k, () => getJSON(`https://jobicy.com/api/v2/remote-jobs?count=30&tag=${encodeURIComponent(k)}`).then(r => r.jobs.map(x => ({ title: x.jobTitle, company: x.companyName, where: x.jobGeo, url: x.url, date: x.pubDate, tags: [].concat(x.jobIndustry || []).join(',') }))))),
    run('himalayas', () => getJSON(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(keys.join(' ') || q)}`).then(r => r.jobs.map(x => ({ title: x.title, company: x.companyName, where: (x.locationRestrictions || []).join(', ') || 'Worldwide', url: x.applicationLink || x.guid, date: x.pubDate, salary: x.minSalary ? `${x.minSalary}-${x.maxSalary} ${x.currency || ''}` : '', tags: (x.categories || []).join(',') })))),
    run('remoteok', () => getJSON('https://remoteok.com/api').then(j => j.slice(1).map(x => ({ title: x.position, company: x.company, where: x.location || 'Worldwide', url: x.url, date: x.date, tags: (x.tags || []).join(',') })))),
    run('weworkremotely', () => getText('https://weworkremotely.com/categories/remote-programming-jobs.rss').then(x => [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const f = t => (m[1].match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1]?.trim() || '';
      const [co, ...rest] = f('title').split(': '); return { title: rest.join(': ') || f('title'), company: co, where: f('region') || 'Worldwide', url: f('link'), date: f('pubDate'), tags: f('category') };
    }))),
  ];
}
const jobLinks = (q, loc, remote) => { const e = encodeURIComponent, where = remote ? 'Worldwide' : loc || 'Pakistan'; return {
  linkedin_jobs: `https://www.linkedin.com/jobs/search/?keywords=${e(q)}&location=${e(where)}${remote ? '&f_WT=2' : ''}&sortBy=DD`,
  linkedin_hiring_posts: `https://www.linkedin.com/search/results/content/?keywords=${e(`hiring ${q} ${remote ? 'remote' : loc}`.trim())}&sortBy=%22date_posted%22`,
  indeed: remote ? `https://www.indeed.com/jobs?q=${e(q + ' remote')}` : `https://pk.indeed.com/jobs?q=${e(q)}&l=${e(loc)}`,
  rozee: `https://www.rozee.pk/job/jsearch/q/${e(q)}`, google_jobs: `https://www.google.com/search?q=${e(`${q} jobs ${where}`)}&ibp=htl;jobs` }; };

async function searchJobs({ query, location = '', level = 'any', remote = false, limit = 15 }) {
  const q = String(query || '').trim(), loc = String(location || '').trim();
  remote = !!remote || /remote|worldwide|anywhere/i.test(loc);
  if (level === 'any' && JUNIOR.test(q)) level = /intern|trainee/i.test(q) ? 'internship' : 'entry';
  const words = [...new Set(q.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean))], keys = words.filter(w => !STOP.has(w)).slice(0, 3);
  const hit = x => { x = String(x || '').toLowerCase(); return keys.filter(k => x.includes(k)).length; };
  const failed = [], searched = [];
  const run = (name, f) => { searched.push(name.split(':')[0]); return cached(`job:${name}|${q}|${loc}|${level}|${remote}`, 600000, f).catch(e => { failed.push(`${name}: ${e.message}`); return []; }).then(a => a.map(j => ({ ...j, src: name.split(':')[0] }))); };
  const tasks = [run('linkedin', () => linkedin(q, loc, level, remote))];
  if (!remote && (!loc || PK_PLACE.test(loc))) tasks.push(run('rozee', async () => {
    const withLevel = level === 'internship' && !/intern/i.test(q) ? await rozee(q + ' internship', loc) : [];
    return withLevel.length ? withLevel : rozee(q, loc);
  }));
  if (remote) tasks.push(...remoteBoards(q, keys, run));
  const seen = new Set();
  const jobs = (await Promise.all(tasks)).flat()
    // site searches (linkedin/rozee) are already relevant; the remote feeds are keyword-filtered here
    .filter(j => j.url && (['linkedin', 'rozee'].includes(j.src) || !keys.length || hit(j.title + ' ' + j.tags) > 0))
    .filter(j => !seen.has(j.url) && seen.add(j.url))
    .map(j => {
      const pk = PK.test(j.where || '') || PK_PLACE.test(j.where || '') ? 'yes' : NOT_PK.test(j.where || '') ? 'no' : 'maybe';
      const lvl = level === 'any' ? 0 : SENIOR.test(j.title) ? -6 : JUNIOR.test(j.title) ? 3 : 0;
      const age = (Date.now() - (Date.parse(j.date) || 0)) / 864e5;
      return { ...j, pk, score: hit(j.title) * 4 + hit(j.tags) + lvl + (remote ? (pk === 'yes' ? 2 : pk === 'no' ? -3 : 0) : 0) + (age < 7 ? 2 : age < 30 ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score || iso(b.date).localeCompare(iso(a.date))).slice(0, limit)
    .map(j => ({ title: j.title, company: j.company, location: j.where || '?', ...(remote ? { open_to_pakistan: j.pk } : {}), salary: j.salary || undefined, experience: j.experience || undefined,
      posted: iso(j.date), deadline: j.deadline || undefined, apply: j.url, source: j.src }));
  let hiring_posts;
  if (process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY) hiring_posts = await webSearch(`site:linkedin.com/posts hiring ${q} ${remote ? 'remote' : loc || 'Pakistan'}`).catch(() => undefined);
  return {
    found: jobs.length, searched: [...new Set(searched)], jobs, hiring_posts, sources_failed: failed.length ? failed : undefined,
    more_links: jobLinks(q, loc, remote),
    note: [jobs.length < 3 ? 'Few matches: try a broader role name or a related skill.' : '', !hiring_posts ? 'LinkedIn hiring *posts* need a search key (TAVILY_API_KEY) or the user opening the linkedin_hiring_posts link; Indeed blocks automated search, so only a link is given.' : ''].filter(Boolean).join(' ') || undefined,
  };
}

// Inside a repeating mission, hide results that earlier runs already reported, so each run only brings news.
// ctx.seen = links reported by previous runs, ctx.newSeen = links collected during this run.
async function onlyNew(p, key, ctx, list) {
  const r = await p, arr = list ? r?.[list] : r;
  if (!ctx?.seen || !Array.isArray(arr)) return r;
  const fresh = arr.filter(x => !x[key] || !ctx.seen.has(x[key]));
  fresh.forEach(x => x[key] && ctx.newSeen.add(x[key]));
  const hidden = arr.length - fresh.length;
  if (!list) return hidden ? { results: fresh, hidden_already_reported_in_earlier_runs: hidden } : fresh;
  return { ...r, [list]: fresh, found: fresh.length, ...(hidden ? { hidden_already_reported_in_earlier_runs: hidden } : {}) };
}

// ---- registry ----
const T = {};
const tool = (name, desc, props, req, run) => T[name] = { desc, run, def: { type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: props, ...(req.length ? { required: req } : {}) } } } };
const str = d => ({ type: 'string', description: d });
const needG = () => { if (!G.connected()) throw new Error('Google is not connected. Tell the user to click "Connect Google" at the top.'); };

tool('web_search', 'Search the web. Returns titles, urls, snippets.', { query: str('search query') }, ['query'], a => webSearch(a.query));
tool('fetch_url', 'Read a web page as plain text (first 5000 chars).', { url: str('http(s) url') }, ['url'], a => fetchUrl(a.url));
tool('search_history', "Search the city's archive of past results (earlier answers of every shop and mission reports), e.g. jobs found last week, papers summarized before, past email summaries. Use it when the user refers to something found earlier.",
  { query: str('keywords'), only_this_shop: { type: 'boolean', description: 'only results from this shop' } }, ['query'],
  (a, ctx) => { const r = ARCHIVE.search(a.query, { agent: a.only_this_shop ? ctx.agent : undefined, k: 8 }); return r.length ? r : 'Nothing in the archive matches that.'; });
tool('search_papers', 'Search academic papers (title, year, citations, abstract, link). source "openalex" (default, all fields) or "arxiv" (newest preprints). Run several queries / from_year to map a field and spot gaps.',
  { query: str('topic keywords'), source: { type: 'string', enum: ['openalex', 'arxiv'] }, from_year: { type: 'integer' }, limit: { type: 'integer' } }, ['query'],
  (a, ctx) => onlyNew(cached(`pp:${a.source}|${a.query}|${a.from_year}|${a.limit}`, 600000, () => a.source === 'arxiv' ? arxiv(a.query, Math.min(a.limit || 8, 12)) : openalex(a.query, Math.min(a.limit || 8, 12), a.from_year)).then(structuredClone), 'link', ctx));
tool('search_jobs', 'Live job listings. Pakistan/city searches use LinkedIn job listings and Rozee.pk; remote searches use LinkedIn remote plus Remotive, Jobicy, Himalayas, RemoteOK, WeWorkRemotely and Jooble. Also returns LinkedIn hiring posts (when a search key is set) and ready links for LinkedIn, Indeed, Rozee and Google Jobs. Call 2-3 times with different short keyword sets.',
  { query: str('short role/skill keywords, e.g. "python developer" or "machine learning"'), location: str('city or country, e.g. "Lahore"; empty = all Pakistan'),
    level: { type: 'string', enum: ['any', 'internship', 'entry'] }, remote: { type: 'boolean', description: 'remote jobs open worldwide' }, limit: { type: 'integer' } }, ['query'],
  (a, ctx) => onlyNew(searchJobs({ ...a, limit: Math.min(a.limit || 15, 25) }), 'apply', ctx, 'jobs'));
tool('calendar_list_events', 'List Google Calendar events between two dates (YYYY-MM-DD or local ISO); defaults to today .. 7 days ahead. Optional text filter q.', { from: str('start'), to: str('end'), q: str('optional filter') }, [],
  a => { needG(); const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10); return G.listEvents({ from: a.from || d(0), to: a.to || d(7), q: a.q }); });
tool('calendar_create_event', 'Create a Google Calendar event. start/end are local ISO like 2026-11-05T15:00:00; date-only = all-day. end defaults to +1h.',
  { title: str(''), start: str(''), end: str(''), description: str(''), location: str(''), attendees: { type: 'array', items: { type: 'string' } } }, ['title', 'start'], a => { needG(); return G.createEvent(a); });
tool('gmail_search', 'Search Gmail with Gmail syntax (e.g. "is:unread newer_than:2d", "from:name"). Returns id/from/subject/date/snippet.', { query: str(''), max: { type: 'integer' } }, ['query'], a => { needG(); return G.searchMail(a.query, Math.min(a.max || 8, 15)); });
tool('gmail_read', 'Read one email body by id (trimmed to 3000 chars).', { id: str('message id') }, ['id'], a => { needG(); return G.readMail(a.id); });
tool('send_email', 'Prepare an email; to="me" emails the user themselves. It goes out after the user approves it (or automatically for emails to the user if they enabled that).', { to: str('recipient email, or "me"'), subject: str(''), body: str('plain text') }, ['to', 'subject', 'body'],
  async (a, ctx) => { let to = String(a.to || '').trim(); if (/^(me|myself|user|the user)$/i.test(to)) { needG(); to = await G.myAddress(); } return ctx.approve({ to, subject: a.subject, body: a.body }); });
tool('remember', 'Save a lasting fact about the user to shared memory that every agent sees (skills, location, goals, preferences). Only stable, useful facts.', { fact: str('one short fact, e.g. "Wants remote ML internships"') }, ['fact'], (a, ctx) => ctx.remember(a.fact));
tool('sheets_list', 'List the Google Sheets known to this app (created here or linked) and which was used last.', {}, [], () => { needG(); return G.sheetList(); });
tool('sheets_create', 'Create a NEW Google Sheet with a header row. It becomes the default sheet. Returns its url.', { title: str('sheet title'), headers: { type: 'array', items: { type: 'string' } } }, ['title'], a => { needG(); return G.sheetCreate(a); });
tool('sheets_link', 'Remember an existing Google Sheet (by URL) so it can be appended to and read.', { url: str('sheet url'), name: str('friendly name') }, ['url', 'name'], a => { needG(); return G.sheetLink(a); });
tool('sheets_append', 'Append rows (array of arrays of cell strings) to a sheet. Pass sheet name/url, or omit to use the last-used sheet.', { sheet: str('name or url (optional)'), rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, ['rows'], a => { needG(); return G.sheetAppend(a); });
tool('sheets_read', 'Read rows from a sheet (first tab). Optional A1 range like A1:H50.', { sheet: str('name or url (optional)'), range: str('A1 range (optional)') }, [], a => { needG(); return G.sheetRead(a); });

export const TOOLS = T;