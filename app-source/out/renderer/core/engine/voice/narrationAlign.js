// Match transcribed phrases to recorded steps.
//
// Time alone is not enough: people click a field and THEN say "now we fill in
// the invoice number" while typing; they say "this is the dashboard" about the
// screen the NEXT screenshot shows; and they add tips about what they just did.
// So each phrase is placed between the step before it (P) and the step after it
// (N), and decided by, in order:
//   0. the phrase is being spoken while the click happens -> that click
//   1. "this is / here is ..."  -> the step whose screenshot shows that screen (N)
//   2. words that name a step's button, field or page (e.g. "invoice")
//   3. tips/notes ("the tip is", "make sure", "only ...") -> the step of the sentence before it
//   4. announcing ("we will", "now I'll", "next", "Click ...", "Enter ...") -> the coming step (N)
//   5. otherwise TIME decides, with a lead window (see below)
// Speech before the first step that sounds like an introduction ("hello,
// today we are going to ...") becomes the guide's introduction (key 0).
//
// Timing model (v4). People talk BEFORE they click ("now click Reports...") and
// AFTER the page has loaded ("as you can see, the list appears..."). Between two
// clicks P and N the timeline is therefore cut at
//     boundary = T(N) - lead(N),   lead(N) = min(LEAD_MS, half the gap)
// Speech before the boundary is the aftermath of P, speech inside the lead window
// is the announcement of N. A phrase is judged by how much of it lies on each
// side (overlap), not by its midpoint, and the phrases are short: sentences /
// pauses cut with Whisper's WORD timestamps (a 3-8 s segment used to be one block,
// so one sentence of it dragged the others to the wrong step).

export const CLICK_SLACK_MS = 1200;   // legacy name, kept for API compatibility: speech this soon after a click is the same gesture
export const LEAD_MS = 2500;          // speech this long before a click still announces it
export const LEAD_GAP_FRACTION = 0.5; // ...but never more than this share of the gap since the previous step
export const DEFAULT_DWELL_MS = 7000; // an "observe" snapshot is taken after a still screen of about this length
export const PAUSE_SPLIT_MS = 800;    // a silence this long between two words ends a phrase
export const NARRATION_VERSION = 4;   // bump when matching changes: old guides are re-matched (v4: word timing + lead/lag windows)
export const INTRO_KEY = 0;

const STOP = new Set(('a an the this that these those is are was were be been am to of in on at for from by with and or but so then now here there '
  + 'we i you it they he she our my your their its me us them will would can could should shall may might must do does did going go goes '
  + 'just also very really okay ok um uh like over up down into out about what which who when where how all any some one two click clicking '
  + 'select selecting enter entering fill filling type typing page screen button field option menu').split(' '));

const stem = (w) => w.slice(0, 5);
const words = (s) => (String(s || '').toLowerCase()
  .replace(/\[redacted:([a-z_]+)\]/g, ' $1 ') // a hidden value still names its kind ("password")
  .match(/[a-z0-9]+/g) || []);
const keyStems = (s) => new Set(words(s).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));

const DESCRIBES_SCREEN = /^(and\s+)?(this is|here is|here's|this page|you can see|now we are (on|in|at)|we are now (on|in|at))\b/i;
const TIP = /\b(tip|note|remember|make sure|be sure|don't forget|do not forget|important|only|must|required|same for all)\b/i;
const ANNOUNCES = /\b(will|going to|gonna|now (i|we|let'?s)|let'?s|next|then)\b/i;
// An instruction said before doing it ("Click Submit.", "Enter your credentials and sign in.") announces the coming step.
const IMPERATIVE = /^\s*(?:(?:and|so|okay|ok|now|then|first|next)[\s,]+)*(?:please\s+)?(?:click|select|choose|press|tap|open|enter|type|fill|go to|navigate|scroll|upload|download|log ?in|sign in|check|tick|pick|search|submit)\b/i;
const INTRO = /\b(hello|hi everyone|welcome|today|in this (video|tutorial|guide)|i will show|i'll show|we are going to|we're going to)\b/i;

function labelScore(phrase, step, { withTitle = true } = {}) {
  const p = keyStems(phrase);
  if (!p.size || !step) return 0;
  let score = 0;
  for (const s of keyStems([step.targetLabel, step.clickedText, withTitle ? step.pageTitle : ''].join(' '))) if (p.has(s)) score += 2;
  return score;
}

/** Split a Whisper segment into sentences / clauses, sharing its time by length. */
export function splitPhrase(p) {
  const parts = String(p.text || '')
    .split(/(?<=[.!?])\s+|,\s+(?=(?:and\s+)?(?:this is|here is|then|now|so now)\b)|\s+(?=and this is\b)/i)
    .map((t) => t.trim()).filter(Boolean);
  if (parts.length <= 1) return [p];
  const total = parts.reduce((n, t) => n + t.length, 0) || 1;
  const span = (p.endMs ?? p.startMs) - p.startMs;
  let t = p.startMs;
  return parts.map((text) => {
    const len = (text.length / total) * span;
    const piece = { startMs: t, endMs: t + len, text };
    t += len;
    return piece;
  });
}

/** Which of the two neighbouring steps does the WORDING point to? null = the words do not say. */
function semanticChoice(text, P, N, last) {
  if (DESCRIBES_SCREEN.test(text)) return N.action === 'complete' || P.action === 'click' ? N : P;
  const sp = labelScore(text, P);
  const sn = labelScore(text, N);
  if (sp !== sn) return sp > sn ? P : N;
  const announces = ANNOUNCES.test(text) || IMPERATIVE.test(text);
  // A tip is about what was just being talked about: the step of the sentence before it.
  if (TIP.test(text) && !announces) return last === P || last === N ? last : P;
  if (announces) return N;
  return null;
}

/** How long before its click a step still claims speech (an "observe" step claims its whole still-screen period). */
function leadFor(step, prev) {
  const gap = prev ? step.timestamp - prev.timestamp : Infinity;
  const dwell = step.action === 'observe' ? (Number.isFinite(step.dwellTimeMs) ? step.dwellTimeMs : DEFAULT_DWELL_MS) : 0;
  return Math.min(LEAD_MS + dwell, gap * LEAD_GAP_FRACTION);
}

/** Share (0..1) of [s, e] that lies before `boundary`. */
function shareBefore(s, e, boundary) {
  if (!(e > s)) return s < boundary ? 1 : 0;
  return Math.max(0, Math.min(e, boundary) - s) / (e - s);
}

/**
 * @param phrases [{ startMs, endMs, text, exact? }]  absolute wall-clock ms (exact: already cut at word level)
 * @param steps   [{ stepNumber, timestamp, action?, dwellTimeMs?, targetLabel?, clickedText?, pageTitle? }]
 * @returns Map stepNumber -> text (phrases joined in order); key 0 = spoken introduction
 */
export function alignNarration(phrases, steps) {
  const ordered = [...steps].filter((s) => Number.isFinite(s.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const out = new Map();
  if (!ordered.length) return out;
  const add = (key, text) => out.set(key, out.has(key) ? `${out.get(key)} ${text}` : text);
  const pieces = [...phrases].sort((a, b) => a.startMs - b.startMs).flatMap((p) => (p.exact ? [p] : splitPhrase(p)));
  let last = null;
  for (const p of pieces) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    const start = p.startMs;
    const end = Number.isFinite(p.endMs) ? p.endMs : p.startMs;
    const mid = (start + end) / 2;
    // The neighbours of the phrase: P = last click before its middle, N = the next one.
    const idx = ordered.findIndex((s) => s.timestamp > mid);
    const N = idx === -1 ? null : ordered[idx];
    const P = idx === -1 ? ordered[ordered.length - 1] : ordered[idx - 1] || null;
    // Page titles (the app or site name) are shared by intros, so only the clicked element counts here.
    if (!P && INTRO.test(text) && !labelScore(text, N, { withTitle: false })) { add(INTRO_KEY, text); continue; }
    if (!P) last = N;
    else if (!N) last = P;                                   // talking on after the last step
    else {
      // Spoken WHILE the click happens ("now click Reports" ... click): that click.
      const during = ordered.find((s) => s.timestamp >= start && s.timestamp <= end);
      const byWords = during ? null : semanticChoice(text, P, N, last);
      if (during) last = during;
      else if (byWords) last = byWords;
      else last = shareBefore(start, end, N.timestamp - leadFor(N, P)) >= 0.5 ? P : N; // time: aftermath of P vs. lead-in of N
    }
    add(last.stepNumber, text);
  }
  return out;
}

/**
 * Strict time-window matching:
 *   S_i = time of step i, E_i = time of step i+1 (last step: end of audio).
 *   A segment whose midpoint falls in [S_i, E_i) belongs to step i.
 *   Segments before S_0 become the guide introduction (key 0).
 * Times are absolute ms here (T0 + relative seconds), which is the same split.
 */
export function alignNarrationTimeWindow(phrases, steps) {
  const ordered = [...steps].filter((s) => Number.isFinite(s.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const out = new Map();
  if (!ordered.length) return out;
  const add = (key, text) => out.set(key, out.has(key) ? `${out.get(key)} ${text}` : text);
  for (const p of [...phrases].sort((a, b) => a.startMs - b.startMs)) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    const mid = (p.startMs + (Number.isFinite(p.endMs) ? p.endMs : p.startMs)) / 2;
    if (mid < ordered[0].timestamp) { add(INTRO_KEY, text); continue; }
    let i = ordered.length - 1; // last step runs until the end of the audio
    while (i > 0 && mid < ordered[i].timestamp) i -= 1;
    add(ordered[i].stepNumber, text);
  }
  return out;
}

export const MATCHING_MODES = { smart: alignNarration, timeWindow: alignNarrationTimeWindow };
export const alignByMode = (mode, phrases, steps) => (MATCHING_MODES[mode] || alignNarration)(phrases, steps);

// Whisper sometimes "hears" stock phrases in silence or noise.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by .*)$/i;

// ---------- Whisper -> phrases ----------

const alnum = (t) => (String(t || '').match(/[a-z0-9]/gi) || []).length;
const CLAUSE_AFTER_COMMA = /^(?:and\s+)?(?:this is|here is|then|now|so now)\b/i;
const AND_THIS_IS = /^and this is\b/i;
const SENTENCE_END = /[.!?]["')\]]*$/;

/**
 * Cut one Whisper segment into phrases and give each its OWN start and end, read
 * from the segment's word timestamps (the text keeps Whisper's punctuation and
 * capitals; the words are only used for timing). Cuts: sentence ends, the clause
 * cues of splitPhrase, and silences of PAUSE_SPLIT_MS or more between words.
 * Returns null when the words do not fit the text (caller falls back to the segment).
 * @param words [{ startMs, endMs, text }] words of this segment, absolute ms
 */
export function splitByWords(text, words, { pauseMs = PAUSE_SPLIT_MS } = {}) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const ws = (words || []).filter((w) => alnum(w.text) > 0).sort((a, b) => a.startMs - b.startMs);
  if (!tokens.length || !ws.length) return null;

  let c = 0;
  const tk = tokens.map((t) => { const a = c; c += alnum(t); return { t, a, b: c }; });
  let wc = 0;
  const span = ws.map((w) => { const A = wc; wc += alnum(w.text); return { A, B: wc, s: w.startMs, e: Math.max(w.endMs, w.startMs) }; });
  const ratio = c ? wc / c : 0;
  if (ratio < 0.7 || ratio > 1.4) return null; // the word list is not this text

  const lerp = (sp, x) => sp.s + ((x - sp.A) / (sp.B - sp.A)) * (sp.e - sp.s);
  const startAt = (x) => { const sp = span.find((q) => x < q.B) || span[span.length - 1]; return lerp(sp, Math.min(Math.max(x, sp.A), sp.B)); };
  const endAt = (x) => { const sp = span.find((q) => x <= q.B && q.B > q.A) || span[span.length - 1]; return lerp(sp, Math.min(Math.max(x, sp.A), sp.B)); };

  const cut = new Set(); // cut after token k
  tk.forEach((q, k) => {
    if (k === tk.length - 1) return;
    const rest = tokens.slice(k + 1, k + 4).join(' ');
    if (SENTENCE_END.test(q.t) || (/,$/.test(q.t) && CLAUSE_AFTER_COMMA.test(rest)) || AND_THIS_IS.test(rest)) cut.add(k);
  });
  for (let j = 1; j < ws.length; j += 1) {
    if (ws[j].startMs - ws[j - 1].endMs < pauseMs) continue;
    const x = span[j].A / ratio; // the silence sits before word j: find the matching token boundary
    let best = -1;
    tk.forEach((q, k) => { if (k < tk.length - 1 && Math.abs(q.b - x) <= 2 && (best === -1 || Math.abs(q.b - x) < Math.abs(tk[best].b - x))) best = k; });
    if (best !== -1) cut.add(best);
  }

  const pieces = [];
  let first = 0;
  tk.forEach((q, k) => {
    if (!cut.has(k) && k !== tk.length - 1) return;
    const startMs = startAt(tk[first].a * ratio);
    pieces.push({ startMs, endMs: Math.max(startMs, endAt(q.b * ratio)), text: tokens.slice(first, k + 1).join(' ') });
    first = k + 1;
  });
  return pieces;
}

/**
 * Audio-clock drift. A long part is stamped with the wall time between its start
 * and stop events (wallMs, monotonic); Whisper reports how long the audio really is
 * (audioMs). When the two differ by clearly more than the start/stop jitter, the
 * audio clock ran slow/fast against the click clock and word times are stretched
 * by wallMs / audioMs. Short parts and implausible gaps (> 2 %: dropped audio, not
 * drift) are left alone.
 */
export const DRIFT_MIN_AUDIO_MS = 60_000;
export const DRIFT_MIN_DIFF_MS = 400;
export const DRIFT_MAX_RATIO = 0.02;
export function driftScale(wallMs, audioMs) {
  if (!(wallMs > 0) || !(audioMs >= DRIFT_MIN_AUDIO_MS)) return 1;
  const diff = Math.abs(wallMs - audioMs);
  return diff >= DRIFT_MIN_DIFF_MS && diff / audioMs <= DRIFT_MAX_RATIO ? wallMs / audioMs : 1;
}

/**
 * Whisper verbose_json (seconds, relative to the file) -> absolute phrases.
 * @param segments       Whisper segments (already filtered for noise / echoes)
 * @param partStartedAt  wall clock (Date.now domain) of the file's first sample
 * @param opts.words     Whisper word list [{ word, start, end }]: phrases are cut and timed per sentence / pause
 * @param opts.scale     drift correction, see driftScale()
 */
export function phrasesFromWhisper(segments, partStartedAt, { words = null, scale = 1 } = {}) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const at = (sec) => partStartedAt + Number(sec || 0) * 1000 * k;
  const kept = (segments || [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .filter((s) => !(Number(s.no_speech_prob) > 0.6))
    .filter((s) => !HALLUCINATIONS.test(s.text.trim()));

  // Each word belongs to the segment it lies in (a little tolerance at the edges).
  const wordsOf = new Map();
  for (const w of Array.isArray(words) ? words : []) {
    const ws = Number(w?.start);
    const we = Number(w?.end ?? w?.start);
    const text = String(w?.word ?? w?.text ?? '').trim();
    if (!Number.isFinite(ws) || !text) continue;
    const mid = (ws + (Number.isFinite(we) ? we : ws)) / 2;
    let best = null;
    let bestDist = 0.15;
    for (const seg of kept) {
      const dist = mid < Number(seg.start) ? Number(seg.start) - mid : mid > Number(seg.end ?? seg.start) ? mid - Number(seg.end ?? seg.start) : 0;
      if (dist <= bestDist) { best = seg; bestDist = dist; if (!dist) break; }
    }
    if (best) {
      if (!wordsOf.has(best)) wordsOf.set(best, []);
      wordsOf.get(best).push({ startMs: at(ws), endMs: at(Number.isFinite(we) ? we : ws), text });
    }
  }

  return kept.flatMap((s) => {
    const whole = { startMs: at(s.start), endMs: at(s.end ?? s.start), text: s.text.trim() };
    const pieces = wordsOf.has(s) ? splitByWords(whole.text, wordsOf.get(s)) : null;
    return pieces ? pieces.map((q) => ({ ...q, exact: true })) : [whole];
  });
}
