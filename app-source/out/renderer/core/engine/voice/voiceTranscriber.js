// Narration text -> steps.
//
//   narration.wav -> whisper.cpp on this computer (main process, see the guides
//   window's transcribeAndAlign) -> sentences with their own word-level start/end
//   -> SCRUBBED -> matched to steps -> step.narration, session.transcript
//
// The audio never leaves the computer. Only scrubbed text is stored next to the
// steps or reaches the guide writer.

import { CONFIG } from '../config.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { scrubTextSync } from '../privacy/textScrubber.js';
import * as store from '../storage/sessionStore.js';
import { alignByMode, INTRO_KEY, NARRATION_VERSION } from './narrationAlign.js';

const MAX_NARRATION_CHARS = 1200;

/**
 * Whisper "prompt": words that appear on screen (button and page names). It
 * makes Whisper spell product terms right (for example "Dashboard", "Invoices",
 * "Export to PDF") instead of guessing. Only scrubbed labels are used, never
 * redacted values.
 */
export function vocabularyPrompt(steps) {
  const words = [];
  for (const s of steps) {
    for (const v of [s.targetLabel, s.pageTitle, s.clickedText]) {
      const t = String(v || '').trim();
      if (t && !/\[REDACTED:/.test(t) && t.length <= 60 && !words.includes(t)) words.push(t);
    }
  }
  // Only a bare word list: on quiet audio Whisper repeats prompt sentences back
  // ("On screen is a great tool..."). Echoes are also filtered below.
  const list = words.join(', ').slice(0, 400);
  return list ? `${list}.` : '';
}

const wordsOf = (s) => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];

/** A segment that is mostly words from the prompt is an echo, not speech. */
export function isPromptEcho(text, prompt) {
  const words = wordsOf(text);
  if (!words.length || !prompt) return false;
  const vocab = new Set(wordsOf(prompt));
  const hits = words.filter((w) => vocab.has(w)).length;
  return words.length >= 2 && hits / words.length >= 0.8;
}

/** Drop Whisper's low-confidence guesses: they are what it produces from noise. */
export function reliableSegments(segments, prompt) {
  return (segments || []).filter((s) => !(Number(s?.avg_logprob) < -1.0)
    && !(Number(s?.compression_ratio) > 2.4)
    && !isPromptEcho(s?.text, prompt));
}

/**
 * Match the stored (scrubbed) phrases to the steps. Instant, no audio needed.
 * Phrases go to steps by the time each click happened, not by the step's position,
 * so moving steps around in the editor never mixes up whose narration is whose.
 * matching: 'smart' (default) or 'timeWindow' (strict time windows).
 * Narration the user corrected by hand on the guide page is kept.
 * @returns {{ ok, stepsWithNarration, intro, error? }}
 */
export async function alignSession(sessionId, { matching = 'smart' } = {}) {
  const session = await store.getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  if (!Array.isArray(session.narrationPhrases)) return { ok: false, error: 'Not transcribed yet' };
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const steps = await store.getSteps(sessionId, { withImages: false });
  const byStep = alignByMode(matching, session.narrationPhrases, steps);
  for (const step of steps) {
    if (step.narrationEdited) continue;
    const raw = byStep.get(step.stepNumber) || '';
    const narration = raw ? scrubTextSync(raw, clf).text.slice(0, MAX_NARRATION_CHARS) : '';
    if ((step.narration || '') !== narration) await store.updateStep(sessionId, step.stepNumber, { narration });
  }
  const intro = byStep.get(INTRO_KEY) || '';
  await store.updateSession(sessionId, {
    voiceStatus: 'done',
    voiceError: null,
    narrationIntro: intro ? scrubTextSync(intro, clf).text.slice(0, MAX_NARRATION_CHARS) : '',
    narrationVersion: NARRATION_VERSION,
    narrationMatching: matching,
    voiceSteps: [...byStep.keys()].filter((k) => k !== INTRO_KEY).length,
  });
  return { ok: true, stepsWithNarration: byStep.size, intro: Boolean(intro) };
}
