// =====================================================================
// Nova StartupOS AI — Secure AI Streaming Proxy (Vercel Serverless / Node.js)
// ---------------------------------------------------------------------
// Route:  POST /api/ai-stream   (mapped in vercel.json)
//
// Responsibilities:
//   1. Verify the caller's Supabase JWT (Authorization: Bearer <token>).
//   2. Read the active provider + cost/priority/model from the
//      `ai_providers_config` table using the SERVICE ROLE key
//      (server-only — never exposed to the browser).
//   3. Inject the hidden master system prompt, call the upstream provider
//      (OpenRouter / OpenAI / DeepSeek / Gemini-compatible chat endpoint),
//      and stream the tokens back to the client as Server-Sent Events.
//
// The frontend (js/ai.js -> NovaAI.generateStream) reads this SSE stream,
// parsing `data: {...}` lines and extracting choices[0].delta.content.
// =====================================================================

const { createClient } = require('@supabase/supabase-js');

// ---- Server-only configuration (Vercel Environment Variables) --------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Per-provider upstream endpoints + the env var holding each secret key.
// All four use the OpenAI-compatible /chat/completions streaming shape.
const PROVIDERS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY' },
  openai:     { url: 'https://api.openai.com/v1/chat/completions',     keyEnv: 'OPENAI_API_KEY' },
  deepseek:   { url: 'https://api.deepseek.com/v1/chat/completions',   keyEnv: 'DEEPSEEK_API_KEY' },
  gemini:     { url: 'https://openrouter.ai/api/v1/chat/completions',  keyEnv: 'OPENROUTER_API_KEY' }, // via OpenRouter
  anthropic:  { url: 'https://openrouter.ai/api/v1/chat/completions',  keyEnv: 'OPENROUTER_API_KEY' }  // via OpenRouter
};

// The hidden master system prompt — never sent from / visible to the client.
const MASTER_SYSTEM_PROMPT =
  'You are Nova, an AI co-founder inside Nova StartupOS AI. You help founders ' +
  'turn ideas into investment-ready startups: business plans, pitch decks, ' +
  'readiness assessments, fundraising strategy, and startup-visa guidance. ' +
  'Be concise, structured, practical, and encouraging. Use clear section ' +
  'headings when producing documents.';

// SSE helper: write one event frame to the response.
function sseWrite(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

module.exports = async (req, res) => {
  // ---- CORS preflight (headers also set globally in vercel.json) ----
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server is not configured (missing Supabase env vars).' });
  }

  try {
    // ---- 1. Verify the Supabase JWT --------------------------------
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token.' });

    // Service-role client (bypasses RLS — used only for trusted server reads).
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Resolve the user from the JWT; reject if invalid/expired.
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    // ---- 2. Parse the request body ---------------------------------
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const prompt = (body.prompt || '').toString();
    const clientSystem = (body.systemPrompt || '').toString();
    let model = (body.model || '').toString();
    if (!prompt.trim()) return res.status(400).json({ error: 'Prompt is required.' });

    // ---- 3. Resolve the routing provider from ai_providers_config --
    // Pick enabled providers ordered by priority (lowest number first);
    // honor is_default as the tie-breaker / primary.
    const { data: configs, error: cfgErr } = await admin
      .from('ai_providers_config')
      .select('provider_name, enabled, priority, is_default, default_model')
      .eq('enabled', true)
      .order('priority', { ascending: true });

    if (cfgErr) return res.status(500).json({ error: 'Could not read AI provider config.' });
    if (!configs || !configs.length) {
      return res.status(503).json({ error: 'No AI provider is currently enabled.' });
    }

    const chosen = configs.find(c => c.is_default) || configs[0];
    const providerName = chosen.provider_name;
    if (!model) model = chosen.default_model || 'google/gemini-flash-1.5';

    const providerMeta = PROVIDERS[providerName];
    if (!providerMeta) return res.status(500).json({ error: 'Unknown provider: ' + providerName });

    const apiKey = process.env[providerMeta.keyEnv];
    if (!apiKey) return res.status(500).json({ error: 'Server key missing for provider: ' + providerName });

    // ---- 4. Open the SSE stream to the client ----------------------
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Compose messages: master prompt + (optional) client context + user prompt.
    const messages = [
      { role: 'system', content: MASTER_SYSTEM_PROMPT },
      ...(clientSystem ? [{ role: 'system', content: clientSystem }] : []),
      { role: 'user', content: prompt }
    ];

    // ---- 5. Call the upstream provider (streaming) -----------------
    const upstream = await fetch(providerMeta.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        // OpenRouter attribution headers (ignored by other providers).
        'HTTP-Referer': 'https://novastartupos.ai',
        'X-Title': 'Nova StartupOS AI'
      },
      body: JSON.stringify({ model, messages, stream: true })
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => upstream.statusText);
      sseWrite(res, { error: 'Upstream error ' + upstream.status + ': ' + errText.slice(0, 300) });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ---- 6. Pipe the upstream SSE through to the client ------------
    // We re-emit the same OpenAI-compatible `data: {...}` frames so the
    // frontend parser (choices[0].delta.content) works unchanged.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.indexOf('data:') !== 0) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) sseWrite(res, { choices: [{ delta: { content: delta } }] });
        } catch (e) {
          // partial JSON split across chunks — ignore and continue buffering
        }
      }
    }

    // Signal completion to the client and close the stream.
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    // If headers were already sent (mid-stream), emit an SSE error frame.
    if (res.headersSent) {
      sseWrite(res, { error: (err && err.message) || 'Stream failed.' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.status(500).json({ error: (err && err.message) || 'Internal error.' });
  }
};
