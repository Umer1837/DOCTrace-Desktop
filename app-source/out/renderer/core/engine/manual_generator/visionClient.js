// Screenshot descriptions from a vision model on this computer (Ollama, or
// another OpenAI-compatible /v1/chat/completions server on localhost).
//
// Only what the manual generator already guarded is sent: the scrubbed text
// prompt and REDACTED screenshots (prepared by imagePrep.js, which runs the
// privacy gate). Requests go through platform.net.fetch, i.e. the main process,
// which refuses anything that is not localhost on a supported port.

import { platform } from '../platform/platform.js';
import { LlmRequestError } from './imagePrep.js';

// Without a graphics card one screenshot can take several minutes, and the first
// request also loads the model from disk.
export const REQUEST_TIMEOUT_MS = 600000;
const SERVER_ERROR_WAIT_MS = 3000;
const CONNECT_RETRY_DELAYS_MS = [1500, 4000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };
const short = (s) => String(s || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 160);

// Machine-readable codes only ("model_not_found"); free text can echo the request.
function errorCode(bodyText) {
  try {
    const e = JSON.parse(bodyText)?.error;
    return [e?.code, e?.type].filter((c) => typeof c === 'string' && /^[a-z][a-z0-9_]{1,60}$/i.test(c)).join(' / ');
  } catch {
    return '';
  }
}

export function buildVisionBody(settings, prompt, images, { jsonMode = true } = {}) {
  const content = [{ type: 'text', text: prompt.user }];
  for (const image of images) {
    content.push(
      { type: 'text', text: `Redacted screenshot for step ${image.stepNumber}:` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.base64}` } },
    );
  }
  return JSON.stringify({
    model: settings.model,
    temperature: 0.3,
    // A five-part step is ~250 tokens; every extra token costs a CPU time.
    // The one-step prompt for this computer sets its own, smaller cap.
    max_tokens: prompt.maxTokens || Math.min(4096, 400 + images.length * 500),
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content },
    ],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
}

// ---------- model discovery ----------
// When the configured model is not installed (for example qwen2.5vl:7b was set
// but only qwen2.5vl:3b was pulled), ask the server which models it has and try
// the ones whose names suggest image input.
const VISION_HINTS = [/vl\b|vl[:_-]/, /vision/, /llava/, /gemma-?3/, /minicpm-v/, /moondream/, /pixtral/, /qwen/];
const NOT_CHAT = /whisper|tts|speech|audio|guard|embed|moderation|rerank|transcri/;
const MAX_CANDIDATES = 4;

const workingModel = new Map(); // `${endpoint}|${configured model}` -> model that worked
export const getWorkingVisionModel = (settings) => workingModel.get(`${settings.endpoint}|${settings.model}`) || null;
export function resetVisionPreferences() { workingModel.clear(); }

export function rankVisionModels(ids) {
  return ids
    .filter((id) => typeof id === 'string' && !NOT_CHAT.test(id.toLowerCase()))
    .map((id) => ({ id, rank: VISION_HINTS.findIndex((re) => re.test(id.toLowerCase())) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || b.id.localeCompare(a.id))
    .map((m) => m.id);
}

async function listModels(settings, fetchImpl) {
  const url = settings.endpoint.replace(/\/chat\/completions\/?$/, '/models');
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: {} });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    return (data?.data || []).filter((m) => m?.active !== false).map((m) => m?.id);
  } catch {
    return [];
  }
}

/** @returns {Promise<string>} the model's text answer (JSON). */
export async function callVisionModel(settings, prompt, images, fetchImpl = (u, i) => platform.net.fetch(u, i, { timeoutMs: REQUEST_TIMEOUT_MS })) {
  const name = settings.providerLabel || 'The AI model';
  if (!settings.enabled) throw new LlmRequestError('DISABLED', 'The AI guide writer is switched off in Settings.');
  if (!Array.isArray(images) || images.length === 0) {
    throw new LlmRequestError('NO_PROTECTED_IMAGES', 'No protected screenshots were available.');
  }

  const cacheKey = `${settings.endpoint}|${settings.model}`;
  const first = workingModel.get(cacheKey) || settings.model;
  const tried = [first];
  try {
    return await requestWithModel(settings, first, prompt, images, fetchImpl, name);
  } catch (err) {
    if (!['MODEL_NOT_FOUND', 'MODEL_REJECTED'].includes(err?.code)) throw err;
    const candidates = rankVisionModels(await listModels(settings, fetchImpl)).filter((m) => !tried.includes(m)).slice(0, MAX_CANDIDATES);
    let lastErr = err;
    for (const model of candidates) {
      tried.push(model);
      console.warn(`DOCTrace: ${name} model '${tried[tried.length - 2]}' unavailable; trying '${model}'`);
      try {
        const text = await requestWithModel(settings, model, prompt, images, fetchImpl, name);
        workingModel.set(cacheKey, model);
        return text;
      } catch (e) {
        if (!['MODEL_NOT_FOUND', 'MODEL_REJECTED'].includes(e?.code)) throw e;
        lastErr = e;
      }
    }
    throw new LlmRequestError('MODEL_NOT_FOUND',
      `${name} has no working image model${candidates.length ? ` (tried ${tried.join(', ')})` : ''}. ${lastErr.message}`);
  }
}

async function requestWithModel(baseSettings, model, prompt, images, fetchImpl, name) {
  const settings = { ...baseSettings, model };
  let jsonMode = true;
  let body = buildVisionBody(settings, prompt, images, { jsonMode });
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    let text = '';
    try {
      response = await fetchImpl(settings.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      text = await response.text();
    } catch (err) {
      const message = short(err?.message);
      // Waiting again for the same model on the same computer would take just as long.
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timed? ?out|aborted/i.test(message)) {
        throw new LlmRequestError('TIMEOUT', `${name} did not answer within ${REQUEST_TIMEOUT_MS / 60000} minutes; a template was used. Try a smaller model (for example qwen2.5vl:3b).`);
      }
      if (attempt < 2) { await sleep(CONNECT_RETRY_DELAYS_MS[attempt]); continue; }
      throw new LlmRequestError('NETWORK_ERROR', `Could not reach ${name} at ${hostOf(settings.endpoint)}. Start it (for Ollama: Start menu > Ollama) and try again. (${message})`);
    }

    if (response.ok) {
      let data;
      try { data = JSON.parse(text); } catch { throw new LlmRequestError('INVALID_RESPONSE', `${name} returned an unreadable response.`); }
      const content = data?.choices?.[0]?.message?.content;
      const answer = Array.isArray(content) ? content.map((p) => p?.text || '').join('\n') : String(content || '');
      // Reasoning models (e.g. Qwen3) may put their thinking before the JSON.
      return answer.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
    }

    if (response.status >= 500 && attempt < 2) { await sleep(SERVER_ERROR_WAIT_MS); continue; }
    if (response.status === 400 && jsonMode) {
      jsonMode = false; // some models reject JSON mode together with images; the prompt still asks for JSON
      body = buildVisionBody(settings, prompt, images, { jsonMode });
      attempt--;
      continue;
    }
    const code = errorCode(text);
    const detail = `${name} request failed for model '${model}' (HTTP ${response.status})${code ? ` - ${code}` : ''}`;
    if (response.status === 404 || /model_(not_found|decommissioned)|not_found/.test(code) || /model .* not found/i.test(text)) {
      throw new LlmRequestError('MODEL_NOT_FOUND', `${detail}. Is it installed? For Ollama run: ollama pull ${model}`);
    }
    if (response.status === 400) {
      throw new LlmRequestError('MODEL_REJECTED', `${detail}; it may not accept images.`);
    }
    throw new LlmRequestError('HTTP_ERROR', `${detail}; a template was used.`);
  }
  throw new LlmRequestError('REQUEST_FAILED', `${name} request failed; a template was used.`);
}
