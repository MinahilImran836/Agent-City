// Free-tier-first LLM router. All providers speak the OpenAI-compatible chat API,
// so one client covers Groq, Gemini, OpenRouter and local Ollama. On 429/errors it
// falls through to the next provider. "Energy" = how much free quota is left.
const E = process.env;
const today = () => new Date().toISOString().slice(0, 10);
const mk = (name, url, model, key, budget) => ({ name, url, model, key, budget, used: 0, day: today(), cool: 0, hdr: null, tokens: 0 });
let list = [];
if (E.GROQ_API_KEY) list.push(mk('groq', 'https://api.groq.com/openai/v1', E.GROQ_MODEL || 'llama-3.3-70b-versatile', E.GROQ_API_KEY, +E.GROQ_DAILY || 1000));
if (E.GEMINI_API_KEY) list.push(mk('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', E.GEMINI_MODEL || 'gemini-2.0-flash', E.GEMINI_API_KEY, +E.GEMINI_DAILY || 200));
if (E.OPENROUTER_API_KEY) list.push(mk('openrouter', 'https://openrouter.ai/api/v1', E.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', E.OPENROUTER_API_KEY, +E.OPENROUTER_DAILY || 50));
if (E.OLLAMA_MODEL) list.push(mk('ollama', E.OLLAMA_URL || 'http://localhost:11434/v1', E.OLLAMA_MODEL, 'ollama', Infinity));
const order = (E.LLM_ORDER || 'groq,gemini,openrouter,ollama').split(',');
list.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

const roll = p => { if (p.day !== today()) { p.day = today(); p.used = 0; p.hdr = null; } };
export const hasProvider = () => list.length > 0;

export function energy() {
  const now = Date.now();
  let tot = 0, rem = 0;
  for (const p of list) {
    roll(p);
    if (p.budget === Infinity) { if (p.cool < now) return 100; continue; }
    const b = p.hdr ? p.hdr.limit : p.budget;
    tot += b; rem += p.cool > now ? 0 : p.hdr ? p.hdr.remaining : Math.max(0, b - p.used);
  }
  return tot ? Math.round(100 * rem / tot) : 0;
}

export function quotaText() {
  if (!list.length) return 'No AI provider configured yet.\nAdd a FREE key to .env: GROQ_API_KEY (console.groq.com), GEMINI_API_KEY (aistudio.google.com), or OLLAMA_MODEL for a local model (unlimited).';
  return `Energy: ${energy()}%  (free AI quota left)\n\n` + list.map(p => {
    roll(p);
    const rest = p.cool > Date.now() ? ` · resting ${Math.ceil((p.cool - Date.now()) / 1000)}s` : '';
    const use = p.budget === Infinity ? 'local, unlimited' : p.hdr ? `${p.hdr.remaining}/${p.hdr.limit} requests left today` : `${p.used}/${p.budget} requests used today`;
    return `${p.name} (${p.model}) · ${use} · ${p.tokens} tokens${rest}`;
  }).join('\n');
}

// chat(messages, tools?, opt?) -> { message, provider }
// If every provider is only briefly rate-limited (per-minute limits), wait it out instead of failing,
// so long-running missions survive bursts instead of dying halfway.
export async function chat(messages, tools, opt = {}) {
  for (let attempt = 0; ; attempt++) {
    const errs = [];
    for (const p of list) {
      roll(p);
      if (p.cool > Date.now()) continue;
      try {
        const body = { model: p.model, messages, temperature: opt.temperature ?? 0.3, max_tokens: opt.maxTokens || 4096 };
        if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
        const r = await fetch(p.url + '/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
          body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
        });
        const lim = r.headers.get('x-ratelimit-limit-requests'), rem = r.headers.get('x-ratelimit-remaining-requests');
        if (lim && rem) p.hdr = { limit: +lim, remaining: +rem };
        if (r.status === 429) { p.cool = Date.now() + Math.min(+r.headers.get('retry-after') || 60, 3600) * 1000; errs.push(`${p.name}: rate limited`); continue; }
        if (!r.ok) { errs.push(`${p.name}: ${r.status} ${(await r.text()).slice(0, 120)}`); if (r.status >= 500 || r.status === 401) p.cool = Date.now() + 30000; continue; }
        const j = await r.json();
        p.used++; p.tokens += j.usage?.total_tokens || 0;
        const message = j.choices?.[0]?.message;
        if (!message || (!message.content && !message.tool_calls?.length)) { errs.push(`${p.name}: empty answer`); continue; }
        return { message, provider: p.name };
      } catch (e) { errs.push(`${p.name}: ${e.message}`); p.cool = Date.now() + 20000; }
    }
    const soonest = Math.min(...list.map(p => p.cool));
    const wait = soonest - Date.now();
    if (attempt < 4 && list.length && wait < 70000) { await new Promise(r => setTimeout(r, Math.max(wait, 1500) + 500)); continue; }
    throw new Error('Out of energy: every free AI provider is resting or unreachable. ' + errs.join(' | '));
  }
}
