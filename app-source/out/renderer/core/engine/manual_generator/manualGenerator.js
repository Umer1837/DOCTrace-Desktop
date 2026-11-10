// Tutorial manual generator.
//
//   stored step (already scrubbed) -> step context (text + metadata only)
//   -> PRIVACY GUARD (re-scrub every value, then prove nothing is left)
//   -> prompt -> AI model on this computer (text only, or with the guarded
//      REDACTED screenshot for a vision model)
//   -> parse JSON
//   -> scrub the answer too -> save manualTitle / manualDescription
//
// Runs in the guides window. It reads steps from docTraceDB without images; a
// vision model gets each step's stored redactedBlob only after the privacy gate
// passes. If the AI is off, not set up, or fails, a rule-based template writes
// the step instead, so a guide is always produced.

import { CONFIG } from '../config.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { scrubTextSync } from '../privacy/textScrubber.js';
import { platform } from '../platform/platform.js';
import * as store from '../storage/sessionStore.js';
import { SYSTEM_PROMPT, VISION_SYSTEM_PROMPT, buildUserPrompt, LOCAL_VISION_SYSTEM_PROMPT, buildLocalUserPrompt } from './prompts.js';
import { loadSettings, llmReady, isVisionProvider, PROVIDERS, rememberModel } from './settings.js';
import { prepareImages, runGroups, LlmRequestError } from './imagePrep.js';
import { callVisionModel, getWorkingVisionModel, REQUEST_TIMEOUT_MS } from './visionClient.js';

// A small model latched onto words from a chat message far from the click (1,500
// characters of screen text) and wrote a step about them. It gets less screen text;
// the words at the click still come separately (textUnderClick / textNearClick).
// Also faster on a CPU.
export const LOCAL_OCR_CHARS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notify = (message) => { try { platform.events?.emit?.(message); } catch { /* nobody listening is fine */ } };

export class PrivacyGuardError extends Error {
  constructor(message) { super(message); this.code = 'PRIVACY_GUARD'; }
}

// ---------- 1. context (what the LLM is allowed to see) ----------
function screenArea(p, width, height) {
  if (!p || !width || !height) return '';
  const col = p.x < width / 3 ? 'left' : p.x > (2 * width) / 3 ? 'right' : 'center';
  const row = p.y < height / 3 ? 'top' : p.y > (2 * height) / 3 ? 'bottom' : 'middle';
  return row === 'middle' && col === 'center' ? 'center of the screen' : `${row}-${col} of the screen`;
}

// Host + path only: no query string, no fragment (stored URLs are scrubbed already).
export function urlPathOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, '') || u.host;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

/** Only these fields can ever reach a prompt. No image, no raw text, no coordinates beyond a coarse area. */
export function buildStepContext(step) {
  return {
    stepNumber: step.stepNumber,
    actionType: step.action,
    targetLabel: step.targetLabel || '',
    textUnderClick: step.clickedText || '',
    textNearClick: step.nearClickText || '',
    clickArea: screenArea(step.clickCoords, step.width, step.height),
    clickedHiddenField: Boolean(step.clickOnRedactedArea),
    hiddenDataOnScreen: step.detectedPiiSummary || [],
    pageTitle: step.pageTitle || '',
    urlPath: urlPathOf(step.url),
    scrubbedOcrText: (step.scrubbedOcrText || '').slice(0, CONFIG.recorder.maxOcrCharsPerStep),
    narration: step.narration || '', // the user's own words, transcribed and scrubbed
  };
}

// ---------- 2. privacy guard ----------
const IMAGE_DATA = /data:image\/|base64,|[A-Za-z0-9+/]{400,}/;

function scrubValue(value, clf) {
  if (typeof value === 'string') return scrubTextSync(value, clf).text;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, clf));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, clf)]));
  }
  return value;
}

function findLeaks(value, clf, path = '') {
  if (typeof value === 'string') {
    const leaks = [];
    if (IMAGE_DATA.test(value)) leaks.push(`${path}: image data`);
    const r = scrubTextSync(value, clf);
    if (r.changed) leaks.push(`${path}: ${r.types.join(', ')}`);
    return leaks;
  }
  if (value instanceof Blob) return [`${path}: binary data`];
  if (Array.isArray(value)) return value.flatMap((v, i) => findLeaks(v, clf, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => findLeaks(v, clf, path ? `${path}.${k}` : k));
  return [];
}

/**
 * Defense in depth. Stored values were scrubbed already; we scrub them AGAIN
 * here, then check that a third pass finds nothing. If anything is still
 * found (or any image data is present), the call is refused: fail closed.
 */
export function guardContexts(contexts, clf) {
  const cleaned = scrubValue(contexts, clf);
  const leaks = findLeaks(cleaned, clf);
  if (leaks.length) throw new PrivacyGuardError(`Prompt blocked, sensitive data found: ${leaks.slice(0, 5).join('; ')}`);
  return cleaned;
}

export function buildPrompt({ sessionTitle, previousSteps = [], contexts, spokenIntro = '' }, clf) {
  const safeContexts = guardContexts(contexts, clf);
  const safeTitle = guardContexts({ t: sessionTitle || '' }, clf).t;
  const safePrevious = guardContexts(previousSteps, clf);
  const safeIntro = guardContexts({ t: spokenIntro || '' }, clf).t;
  const user = buildUserPrompt({ sessionTitle: safeTitle, previousSteps: safePrevious, steps: safeContexts, spokenIntro: safeIntro });
  if (IMAGE_DATA.test(user)) throw new PrivacyGuardError('Prompt blocked: image data found');
  return { system: SYSTEM_PROMPT, user };
}

// One step for a small vision model on this computer (see prompts.js). Same privacy
// guard as buildPrompt; the answer is capped (a step is ~150-300 tokens; every extra token
// costs a CPU about 0.2 s).
export const LOCAL_MAX_TOKENS = 450;
export function buildLocalPrompt({ contexts, spokenIntro = '' }, clf) {
  if (contexts.length !== 1) throw new Error('A local model gets one step per request');
  const [step] = guardContexts(contexts, clf);
  const safeIntro = guardContexts({ t: spokenIntro || '' }, clf).t;
  const user = buildLocalUserPrompt({ step, spokenIntro: safeIntro });
  if (IMAGE_DATA.test(user)) throw new PrivacyGuardError('Prompt blocked: image data found');
  return { system: LOCAL_VISION_SYSTEM_PROMPT, user, local: true, maxTokens: LOCAL_MAX_TOKENS + (safeIntro ? 120 : 0) };
}
const useLocalPrompt = (cfg) => isVisionProvider(cfg);
// A note comes only from what the person said ("Never invent a note"); small models fill it
// with a summary of the screen, so it is cleared for steps without narration.
export function dropUnspokenNotes(results, contexts) {
  for (const c of contexts) if (!c.narration && results.has(c.stepNumber)) results.get(c.stepNumber).note = '';
  return results;
}

// ---------- 3. AI model on this computer ----------
// Requests go through platform.net.fetch (the main process), which only allows
// localhost on the supported ports. A direct fetch() from the window would be
// blocked by the window's Content-Security-Policy.
async function postJson(url, body) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await platform.net.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      const message = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (/timed? ?out|aborted/i.test(message)) throw new Error(`The AI model at ${host} did not answer within ${REQUEST_TIMEOUT_MS / 60000} minutes; templates were used.`);
      if (attempt === 0) { await sleep(1500); continue; }
      throw new Error(`Could not reach the AI model at ${host}. Start it (for Ollama: Start menu > Ollama) and try again.`);
    }
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt === 0) { await sleep(1500); continue; }
    throw new Error(res.status === 404
      ? `The AI model at ${host} was not found (HTTP 404). Check the model name; for Ollama run "ollama pull <model>".`
      : `The AI model at ${host} returned HTTP ${res.status}.`);
  }
  throw new Error(`The AI model at ${host} did not answer.`);
}

export async function callLLM(settings, prompt, { images = [] } = {}) {
  const { system, user } = prompt;
  if (isVisionProvider(settings)) {
    // Vision model: the scrubbed text plus the guarded REDACTED screenshot.
    const visionPrompt = prompt.local
      ? { system: prompt.system, user, maxTokens: prompt.maxTokens }
      : { system: VISION_SYSTEM_PROMPT, user };
    const text = await callVisionModel({ ...settings, providerLabel: PROVIDERS[settings.provider].short }, visionPrompt, images);
    const found = getWorkingVisionModel(settings);
    if (found && found !== settings.model) await rememberModel(settings.provider, found).catch(() => {});
    return text;
  }
  // Text-only model (Ollama text model, LM Studio): scrubbed text, no screenshots.
  const data = await postJson(settings.endpoint, {
    model: settings.model,
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const answer = data.choices?.[0]?.message?.content || '';
  return String(answer).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ---------- 4. parsing ----------
export function parseManualResponse(text, expectedNumbers) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('LLM answer contained no JSON');
  const json = JSON.parse(cleaned.slice(start, end + 1));
  // A single step may come back as one bare object instead of {"steps":[...]}.
  const bare = json && !Array.isArray(json) && !Array.isArray(json.steps) && (json.actionInstruction || json.instruction);
  const list = Array.isArray(json) ? json : bare ? [json] : json.steps;
  if (!Array.isArray(list)) throw new Error('LLM answer has no "steps" list');
  const field = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const byNumber = new Map();
  // Small models often copy the example's "stepNumber": 1 (one step per request, so
  // step 2's answer said 1 and was dropped for a template). When the answer has exactly as
  // many entries as steps asked for but the numbers do not match them, take them in order.
  const items = list.filter((item) => item && typeof item === 'object');
  const numbersMatch = items.every((item) => expectedNumbers.includes(Number(item.stepNumber)))
    && new Set(items.map((item) => Number(item.stepNumber))).size === items.length;
  const byOrder = !numbersMatch && items.length === expectedNumbers.length;
  for (const [i, item] of items.entries()) {
    const n = byOrder ? expectedNumbers[i] : Number(item?.stepNumber);
    // Five-part schema (stepTitle/actionInstruction/...); title/instruction still accepted.
    const instruction = field(item?.actionInstruction ?? item?.instruction, 1000);
    if (!expectedNumbers.includes(n) || !instruction) continue;
    byNumber.set(n, {
      title: field(item.stepTitle ?? item.title, 80),
      instruction: instruction.replace(/^step\s*\d+\s*[:.-]\s*/i, '').slice(0, 400),
      screenContext: field(item.screenContext, 500),
      uiLandmarks: field(item.uiLandmarks ?? item.uiLandmark, 300),
      expectedOutcome: field(item.expectedOutcome, 400),
      note: field(item.note, 400),
    });
  }
  return byNumber;
}

export const RICH_PARTS = ['screenContext', 'uiLandmarks', 'expectedOutcome', 'note'];

/** The guide introduction from an answer ("" when absent). Scrubbed like every answer. */
export function parseIntro(text, clf) {
  try {
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const json = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    const intro = typeof json?.intro === 'string' ? json.intro.trim().slice(0, 600) : '';
    return intro ? humanizeTokens(scrubTextSync(intro, clf).text) : '';
  } catch {
    return '';
  }
}

// ---------- 5. template fallback (no LLM needed) ----------
const quoted = (s) => (s ? `'${s}'` : '');
const usable = (s) => s && !/\[REDACTED:/.test(s) ? s.trim() : '';

export function templateDescription(ctx) {
  const label = usable(ctx.targetLabel) || usable(ctx.textUnderClick);
  const where = ctx.clickArea ? ` in the ${ctx.clickArea}` : '';
  const page = usable(ctx.pageTitle);
  if (ctx.actionType === 'observe') {
    return { title: page ? `Review ${page}`.slice(0, 60) : 'Review the page', instruction: page ? `Review the ${quoted(page)} page.` : 'Review the information shown on this page.' };
  }
  if (ctx.actionType === 'complete') {
    return { title: 'Task Complete', instruction: page ? `The task is complete. You are now on the ${quoted(page)} page.` : 'The task is complete.' };
  }
  if (ctx.actionType === 'navigate') {
    const dest = page || ctx.urlPath;
    return { title: 'Open the page', instruction: dest ? `Go to ${dest}.` : 'Open the next page.' };
  }
  if (ctx.actionType === 'input') {
    const hidden = ctx.clickedHiddenField || /\[REDACTED:/.test(ctx.targetLabel || '');
    const field = label ? `the ${quoted(label)} field` : 'the highlighted field';
    return { title: label ? `Fill in ${label}`.slice(0, 40) : 'Fill in the field', instruction: hidden ? `Enter your details in ${field}.` : `Type the required information in ${field}.` };
  }
  return {
    title: label ? `Click ${label}`.slice(0, 40) : 'Click the highlighted item',
    instruction: label ? `Click ${quoted(label)}${where}.` : `Click the highlighted item${where}.`,
  };
}

// ---------- 6. generation ----------
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function saveDescriptions(sessionId, results, source) {
  for (const [n, r] of results) {
    await store.updateStep(sessionId, n, {
      manualTitle: r.title,
      manualDescription: r.instruction,       // = actionInstruction
      manualScreenContext: r.screenContext || '',
      manualUiLandmarks: r.uiLandmarks || '',
      manualExpectedOutcome: r.expectedOutcome || '',
      manualNote: r.note || '',
      descriptionSource: source,
    });
  }
}

function safeErrorMessage(error, settings) {
  if (isVisionProvider(settings)) {
    return error instanceof LlmRequestError
      ? error.message
      : `${PROVIDERS[settings.provider]?.short || 'The AI model'} could not process this step; a template was used.`;
  }
  const message = String(error?.message || error || 'The AI request failed');
  return message
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
    .replace(/[A-Za-z0-9+/]{400,}={0,2}/g, '[binary omitted]')
    .slice(0, 300);
}

export function reconcileManualDescriptions(contexts, answer, clf) {
  const results = scrubAnswer(parseManualResponse(answer, contexts.map((c) => c.stepNumber)), clf);
  const missing = contexts.filter((context) => !results.has(context.stepNumber));
  const fallback = new Map(missing.map((context) => [context.stepNumber, templateDescription(context)]));
  return { results, fallback };
}

export function isManualStepEligible(step, force = false) {
  return step.status === 'redacted'
    && step.descriptionSource !== 'user'
    && (force || step.descriptionSource !== 'llm');
}

// Readers should never see raw tokens in a manual.
const TOKEN_WORDS = {
  email: 'your email address', phone: 'your phone number', cnic: 'your CNIC number', password: 'your password',
  api_key: 'your API key', credit_card: 'your card number', iban: 'your IBAN', passport: 'your passport number',
  national_id: 'your ID number', bank_account: 'your bank account details', date_of_birth: 'your date of birth', sensitive_text: 'the required details',
};
export function humanizeTokens(text) {
  return String(text)
    .replace(/'?\[REDACTED:([a-z_]+)\]'?(\s*'?\[REDACTED:\1\]'?)*/g, (_, t) => TOKEN_WORDS[t] || 'the hidden details')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Scrub what the LLM wrote, just in case it echoed something sensitive, then make tokens readable. */
function scrubAnswer(results, clf) {
  const removeImagePayload = (text) => String(text)
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
    .replace(/[A-Za-z0-9+/]{400,}={0,2}/g, '[hidden content]');
  for (const r of results.values()) {
    for (const key of ['title', 'instruction', ...RICH_PARTS]) {
      if (typeof r[key] === 'string') r[key] = humanizeTokens(scrubTextSync(removeImagePayload(r[key]), clf).text);
    }
  }
  return results;
}

/**
 * Batch mode: describe every step of a finished session.
 * User-authored descriptions are always kept. Without force, existing LLM
 * descriptions are kept too; templates and undescribed steps may be regenerated.
 * @returns {{ ok, provider, llmSteps, templateSteps, error? }}
 */
export async function generateManual(sessionId, { force = false, settings = null } = {}) {
  const cfg = settings || await loadSettings();
  const session = await store.getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  const vision = isVisionProvider(cfg);
  if (vision && session.status !== 'complete') {
    return { ok: false, error: 'Screenshot descriptions are generated after the recording ends.' };
  }
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const steps = (await store.getSteps(sessionId, { withImages: false }))
    .filter((step) => isManualStepEligible(step, force));
  await store.updateSession(sessionId, { manualStatus: 'generating', manualError: null, manualProgress: { done: 0, total: steps.length } });

  // Guide introduction from what was said before the first click (voice narration).
  let introPending = Boolean(session.narrationIntro) && session.manualIntroSource !== 'user' && (force || !session.manualIntro);
  let guideIntro = '';
  let llmSteps = 0;
  let templateSteps = 0;
  let lastError = null;
  const written = [];
  const groupSize = vision
    ? positiveInteger(PROVIDERS[cfg.provider].maxImages, 1) // screenshots per request
    : positiveInteger(cfg.stepsPerCall, 5);
  const groups = chunk(steps, groupSize);
  const firstStepNumber = steps[0]?.stepNumber;

  // Context for a group = the steps before it. Built from data that exists up
  // front (written text if any, else the action + what was said).
  const allSteps = await store.getSteps(sessionId, { withImages: false });
  const priorSteps = (group) => allSteps
    .filter((s) => s.stepNumber < group[0].stepNumber && s.status === 'redacted')
    .slice(-3)
    .map((s) => {
      const base = s.manualDescription || templateDescription(buildStepContext(s)).instruction;
      return { stepNumber: s.stepNumber, instruction: s.narration ? `${base} (said: "${s.narration.slice(0, 200)}")` : base };
    });

  const writeGroup = async (group, { results = new Map(), error = null, skippedStepNumbers = [] } = {}) => {
    const contexts = group.map(buildStepContext);
    if (results.size) {
      llmSteps += results.size;
      await saveDescriptions(sessionId, results, 'llm');
      await store.updateSession(sessionId, { manualGeneratedBy: `${cfg.provider}:${cfg.model}` });
    }
    const missing = contexts.filter((context) => !results.has(context.stepNumber));
    const fallback = new Map(missing.map((context) => [context.stepNumber, templateDescription(context)]));
    templateSteps += fallback.size;
    await saveDescriptions(sessionId, fallback, 'template');
    if (error) lastError = safeErrorMessage(error, cfg);
    else if (skippedStepNumbers.length) lastError = 'Some screenshots could not be safely prepared; templates were used for those steps.';
    for (const context of contexts) {
      const description = results.get(context.stepNumber) || fallback.get(context.stepNumber);
      written.push({ stepNumber: context.stepNumber, instruction: description.instruction });
    }
    // Progress for the Guides page ("Writing step descriptions... 6 of 10").
    await store.updateSession(sessionId, { manualProgress: { done: written.length, total: steps.length } });
    notify({ type: 'SC_MANUAL_UPDATED', sessionId });
  };

  try {
    if (vision) {
      const ready = llmReady(cfg);
      if (!ready) {
        for (const group of groups) await writeGroup(group);
      } else {
        const describe = async (group) => {
          const contexts = group.map(buildStepContext)
            .map((c) => ({ ...c, scrubbedOcrText: c.scrubbedOcrText.slice(0, LOCAL_OCR_CHARS) }));
          const previousSteps = priorSteps(group);
          // Privacy guard on the text first: nothing is read from storage for a prompt that would be refused.
          buildPrompt({ sessionTitle: session.sessionTitle, previousSteps, contexts }, clf);

          const { images, skippedStepNumbers } = await prepareImages(group, store.getStep);
          const imageNumbers = new Set(images.map((image) => image.stepNumber));
          const safeContexts = contexts.filter((context) => imageNumbers.has(context.stepNumber));
          if (!images.length) return { results: new Map(), skippedStepNumbers };

          const withIntro = introPending && group.some((s) => s.stepNumber === firstStepNumber);
          const prompt = useLocalPrompt(cfg) && safeContexts.length === 1
            ? buildLocalPrompt({ contexts: safeContexts, spokenIntro: withIntro ? session.narrationIntro : '' }, clf)
            : buildPrompt({
              sessionTitle: session.sessionTitle,
              previousSteps,
              contexts: safeContexts,
              spokenIntro: withIntro ? session.narrationIntro : '',
            }, clf);
          const answer = await callLLM(cfg, prompt, { images });
          const { results } = reconcileManualDescriptions(safeContexts, answer, clf);
          if (prompt.local) dropUnspokenNotes(results, safeContexts);
          if (withIntro) { guideIntro = parseIntro(answer, clf); introPending = !guideIntro; }
          return { results, skippedStepNumbers };
        };
        await runGroups(groups, describe, writeGroup);
      }
    } else {
      for (const group of groups) {
        const contexts = group.map(buildStepContext)
          .map((c) => ({ ...c, scrubbedOcrText: c.scrubbedOcrText.slice(0, LOCAL_OCR_CHARS) }));
        let results = new Map();
        if (llmReady(cfg)) {
          try {
            const withIntro = introPending && written.length === 0;
            const prompt = buildPrompt({
              sessionTitle: session.sessionTitle, previousSteps: written.slice(-3), contexts,
              spokenIntro: withIntro ? session.narrationIntro : '',
            }, clf);
            const answer = await callLLM(cfg, prompt);
            ({ results } = reconcileManualDescriptions(contexts, answer, clf));
            if (withIntro) { guideIntro = parseIntro(answer, clf); introPending = !guideIntro; }
          } catch (error) {
            lastError = safeErrorMessage(error, cfg);
          }
        }
        await writeGroup(group, { results });
      }
    }

    const finalSteps = await store.getSteps(sessionId, { withImages: false });
    const savedLlmSteps = finalSteps.filter((step) => step.descriptionSource === 'llm').length;
    const savedTemplateSteps = finalSteps.filter((step) => step.descriptionSource === 'template').length;
    const provider = llmSteps ? `${cfg.provider}:${cfg.model}` : (savedLlmSteps ? session.manualGeneratedBy : 'template');
    await store.updateSession(sessionId, {
      ...(guideIntro ? { manualIntro: guideIntro } : {}),
      manualStatus: savedLlmSteps ? 'done' : 'template',
      manualGeneratedBy: provider || 'template',
      manualError: lastError,
      manualLlmSteps: savedLlmSteps,
      manualTemplateSteps: savedTemplateSteps,
    });
    return { ok: true, provider, llmSteps, templateSteps, error: lastError || undefined };
  } catch (error) {
    const message = safeErrorMessage(error, cfg);
    await store.updateSession(sessionId, { manualStatus: 'error', manualError: message });
    return { ok: false, error: message };
  }
}

/**
 * Describe one step again ("Rewrite" on the guide page).
 * A vision model gets this step's guarded REDACTED screenshot; a text model gets text only.
 */
export async function generateStepDescription(sessionId, stepNumber, { settings = null } = {}) {
  const cfg = settings || await loadSettings();
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const session = await store.getSession(sessionId);
  const step = await store.getStep(sessionId, stepNumber);
  if (!session || !step || step.status !== 'redacted' || step.descriptionSource === 'user') return { ok: false, skipped: true };
  const ctx = buildStepContext({ ...step, redactedBlob: undefined });
  const previous = (await store.getSteps(sessionId, { withImages: false }))
    .filter((s) => s.stepNumber < stepNumber && s.manualDescription)
    .slice(-3)
    .map((s) => ({ stepNumber: s.stepNumber, instruction: s.manualDescription }));
  const vision = isVisionProvider(cfg); // the model reads the screenshot
  const trimmed = { ...ctx, scrubbedOcrText: ctx.scrubbedOcrText.slice(0, LOCAL_OCR_CHARS) };

  if (llmReady(cfg)) {
    try {
      const prompt = useLocalPrompt(cfg)
        ? buildLocalPrompt({ contexts: [trimmed] }, clf)
        : buildPrompt({ sessionTitle: session.sessionTitle, previousSteps: previous, contexts: [trimmed] }, clf);
      let images = [];
      if (vision) {
        // Only the stored redactedBlob, and only after the privacy gate passes.
        ({ images } = await prepareImages([{ sessionId, stepNumber }], store.getStep));
        if (!images.length) throw new LlmRequestError('NO_PROTECTED_IMAGES', 'This screenshot could not be safely prepared; a template was used.');
      }
      const { results } = reconcileManualDescriptions([ctx], await callLLM(cfg, prompt, { images }), clf);
      if (prompt.local) dropUnspokenNotes(results, [ctx]);
      if (results.has(stepNumber)) {
        await saveDescriptions(sessionId, results, 'llm');
        await store.updateSession(sessionId, { manualGeneratedBy: `${cfg.provider}:${cfg.model}` });
        return { ok: true, source: 'llm' };
      }
    } catch (err) {
      await saveDescriptions(sessionId, new Map([[stepNumber, templateDescription(ctx)]]), 'template');
      return { ok: true, source: 'template', error: safeErrorMessage(err, cfg) };
    }
  }
  await saveDescriptions(sessionId, new Map([[stepNumber, templateDescription(ctx)]]), 'template');
  return { ok: true, source: 'template' };
}
