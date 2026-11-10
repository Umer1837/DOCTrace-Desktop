// Guide-writer settings, kept in the app's key-value store (platform.kv).
//
// DOCTrace works offline. The guide is written by an AI model running on this
// computer, reached through an OpenAI-compatible /v1/chat/completions server
// (Ollama or LM Studio). The main process only lets requests through to
// localhost on ports 11434 (Ollama), 1234 (LM Studio) and 8080 (llama.cpp
// server), so nothing leaves the computer: no API keys, no cloud consent.
// The AI is OFF until the user turns it on; without it every step gets a
// rule-based description.

import { platform } from '../platform/platform.js';

export const SETTINGS_KEY = 'docTraceManualSettings';
// Saved by earlier versions that also offered cloud services; removed on first load.
const OLD_SETTINGS_KEY = 'scManualSettings';

// vision: the model reads the redacted screenshots. maxImages: screenshots per
// request (a model on a CPU reads one image at a time).
export const PROVIDERS = {
  ollamaVision: {
    label: 'Ollama, reads the screenshots (recommended)',
    short: 'Ollama',
    vision: true,
    maxImages: 1,
    endpoint: 'http://localhost:11434/v1/chat/completions',
    // Reads on-screen text (buttons, menus, forms) well. Faster on a PC without a
    // graphics card: qwen2.5vl:3b.
    model: 'qwen2.5vl:7b',
  },
  ollamaText: {
    label: 'Ollama, text only (faster, does not read screenshots)',
    short: 'Ollama',
    vision: false,
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
  },
  lmStudio: {
    label: 'LM Studio, text only',
    short: 'LM Studio',
    vision: false,
    endpoint: 'http://localhost:1234/v1/chat/completions',
    model: 'local-model',
  },
};
export const DEFAULT_PROVIDER = 'ollamaVision';

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
export const LOCAL_PORTS = ['11434', '1234', '8080'];

export function isLocalEndpoint(url) {
  try { return LOCAL_HOSTS.includes(new URL(url).hostname); } catch { return false; }
}

/** The same rule the main process enforces: this computer, a supported port, http(s). */
export function isAllowedEndpoint(url) {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.includes(u.hostname) && LOCAL_PORTS.includes(u.port) && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

export const isVisionProvider = (s) => Boolean(PROVIDERS[s?.provider]?.vision);

export const DEFAULT_SETTINGS = {
  enabled: false,
  provider: DEFAULT_PROVIDER,
  endpoint: PROVIDERS[DEFAULT_PROVIDER].endpoint,
  model: PROVIDERS[DEFAULT_PROVIDER].model,
  // Text-only models: steps per request. Small, so the prompt fits Ollama's
  // context (OLLAMA_CONTEXT_LENGTH=8192) together with the instructions.
  stepsPerCall: 5,
};

// Fields that only existed for cloud services; their presence means the saved
// settings still need cleaning (API keys were stored there in plain text).
const CLOUD_FIELDS = ['apiKey', 'apiKeys', 'consent', 'imageConsent', 'consentFor', 'mode', 'geminiStepsPerCall', 'llmConcurrency', 'learnedPerRequest', 'timeoutMs'];

/** Saved settings -> current shape. Pure: also used by tests. */
export function normalize(saved = {}) {
  const known = Boolean(PROVIDERS[saved.provider]);
  const provider = known ? saved.provider : DEFAULT_PROVIDER;
  const preset = PROVIDERS[provider];
  const steps = Number(saved.stepsPerCall);
  return {
    // A cloud service that was switched on is not silently replaced by a local
    // server the user may not have installed: the AI starts switched off.
    enabled: known ? Boolean(saved.enabled) : false,
    provider,
    endpoint: known && isAllowedEndpoint(saved.endpoint) ? saved.endpoint : preset.endpoint,
    model: known && typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : preset.model,
    stepsPerCall: Number.isInteger(steps) && steps >= 1 && steps <= 10 ? steps : DEFAULT_SETTINGS.stepsPerCall,
  };
}

export async function loadSettings() {
  const data = await platform.kv.get([SETTINGS_KEY, OLD_SETTINGS_KEY]);
  const saved = data[SETTINGS_KEY] || data[OLD_SETTINGS_KEY] || {};
  const s = normalize(saved);
  // Remove cloud leftovers (including any stored API key) the first time they are seen.
  if (data[OLD_SETTINGS_KEY] || CLOUD_FIELDS.some((k) => k in saved) || (data[SETTINGS_KEY] && !PROVIDERS[saved.provider])) {
    await platform.kv.set({ [SETTINGS_KEY]: s });
    if (data[OLD_SETTINGS_KEY]) await platform.kv.remove(OLD_SETTINGS_KEY);
  }
  return s;
}

export async function saveSettings(settings) {
  const s = normalize(settings);
  await platform.kv.set({ [SETTINGS_KEY]: s });
  return s;
}

/** Save a model that was discovered to work, if that provider is still the selected one. */
export async function rememberModel(provider, model) {
  if (!platform.kv.available?.() || !provider || !model) return;
  const data = await platform.kv.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY];
  if (!saved || saved.provider !== provider || saved.model === model) return;
  await platform.kv.set({ [SETTINGS_KEY]: { ...saved, model } });
}

export const llmReady = (s) => Boolean(
  s?.enabled
  && PROVIDERS[s.provider]
  && s.model
  && isAllowedEndpoint(s.endpoint),
);
