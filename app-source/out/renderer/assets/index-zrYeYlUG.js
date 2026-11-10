import { d as dt, b as bgraToPng, r as reactExports, j as jsxRuntimeExports, c as createRoot } from "./native-QC5-axeK.js";
// Shown under the app name. Keep equal to "version" in package.json (tools/check.js tests it).
const APP_VERSION = "3.0.0";
const BASE = `${location.origin}/core/`;
const load = (path) => import(
  /* @vite-ignore */
  BASE + path
);
let corePromise = null;
function loadCore() {
  if (!corePromise) {
    corePromise = (async () => {
      const [platform, config, pipeline, recorder2, store, manual, settings, voiceSettings, transcriber, align, markdown, guideExport, shared, scrubber, ml] = await Promise.all([
        load("engine/platform/platform.js"),
        load("engine/config.js"),
        load("engine/pipeline.js"),
        load("engine/recorder/recorderService.js"),
        load("engine/storage/sessionStore.js"),
        load("engine/manual_generator/manualGenerator.js"),
        load("engine/manual_generator/settings.js"),
        load("engine/voice/voiceSettings.js"),
        load("engine/voice/voiceTranscriber.js"),
        load("engine/voice/narrationAlign.js"),
        load("engine/storage/manualMarkdown.js"),
        load("ui/lib/guideExport.js"),
        load("ui/lib/shared.js"),
        load("engine/privacy/textScrubber.js"),
        load("engine/detection/mlClassifier.js")
      ]);
      return { platform, config, pipeline, recorder: recorder2, store, manual, settings, voiceSettings, transcriber, align, markdown, guideExport, shared, scrubber, ml };
    })();
  }
  return corePromise;
}
async function classifier() {
  const c = await loadCore();
  return c.ml.loadClassifier(c.config.CONFIG.ml.modelUrl);
}
async function scrub(text) {
  const c = await loadCore();
  return c.scrubber.scrubTextSync(text || "", await classifier()).text;
}
const coreBus = new EventTarget();
function onCoreMessage(type, fn) {
  const h = (e) => fn(e.detail);
  coreBus.addEventListener(type, h);
  return () => coreBus.removeEventListener(type, h);
}
const kv = {
  available: () => true,
  async get(keys) {
    const out = {};
    const list = keys == null ? Object.keys(localStorage) : Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const raw = localStorage.getItem(k);
      if (raw != null) {
        try {
          out[k] = JSON.parse(raw);
        } catch {
        }
      }
    }
    return out;
  },
  async set(obj) {
    for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v));
  },
  async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(k);
  }
};
const headerObject = (h) => {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
};
async function netFetch(url, init = {}, opts = {}) {
  if (init.body != null && typeof init.body !== "string") throw new Error("Only text request bodies are supported.");
  const request = dt.ai.fetch({ url, method: init.method || "GET", headers: headerObject(init.headers), body: init.body ?? null, timeoutMs: opts.timeoutMs });
  const aborted = new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("The request timed out", "AbortError")), { once: true });
  });
  const res = await Promise.race([request, aborted]);
  return {
    ok: res.ok,
    status: res.status,
    headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
    text: async () => res.text,
    json: async () => JSON.parse(res.text)
  };
}
let installed = null;
function installDesktopHost() {
  if (!installed) {
    installed = (async () => {
      const core = await loadCore();
      core.platform.setPlatform({
        name: "electron-desktop",
        kv,
        // AI requests go to the main process, which only allows the AI model on this computer.
        net: { fetch: netFetch },
        // Progress messages from the engine (SC_STEP_DONE, SC_MANUAL_UPDATED) for this window.
        events: {
          emit: (msg) => queueMicrotask(() => coreBus.dispatchEvent(new CustomEvent(msg?.type || "message", { detail: msg })))
        }
      });
    })();
  }
  return installed;
}
// The AI models DOCTrace can use, all on this computer (see engine/manual_generator/settings.js).
async function providerList() {
  const { settings } = await loadCore();
  return Object.entries(settings.PROVIDERS).map(([id, p]) => ({ id, ...p }));
}
async function saveAiChoice(choice) {
  const { settings } = await loadCore();
  return settings.saveSettings({
    ...await settings.loadSettings(),
    enabled: choice.enabled,
    provider: choice.provider,
    endpoint: choice.endpoint,
    model: choice.model
  });
}
async function loadAiChoice() {
  const { settings } = await loadCore();
  const s = await settings.loadSettings();
  return {
    enabled: s.enabled,
    provider: s.provider,
    endpoint: s.endpoint,
    model: s.model,
    ready: settings.llmReady(s),
    endpointOk: settings.isAllowedEndpoint(s.endpoint)
  };
}
async function writeGuide(sessionId, { force = false } = {}) {
  const { manual } = await loadCore();
  return manual.generateManual(sessionId, { force });
}
async function rewriteStep(sessionId, stepNumber) {
  const { manual } = await loadCore();
  return manual.generateStepDescription(sessionId, stepNumber);
}
const imageScale = (h) => h.monitor.width > 0 ? h.width / h.monitor.width : 1;
function hookToImage(p, h) {
  const k = imageScale(h);
  return { x: Math.round((p.x - h.monitor.x) * k), y: Math.round((p.y - h.monitor.y) * k) };
}
const pointInRect = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
function windowCrop(h, click = null, minSide = 120) {
  const w = h.window;
  if (!w || w.isOwn || !(w.bounds.width > 0) || !(w.bounds.height > 0)) return null;
  const k = imageScale(h);
  const x0 = Math.max(0, Math.round((w.bounds.x - h.monitor.x) * k));
  const y0 = Math.max(0, Math.round((w.bounds.y - h.monitor.y) * k));
  const x1 = Math.min(h.width, Math.round((w.bounds.x + w.bounds.width - h.monitor.x) * k));
  const y1 = Math.min(h.height, Math.round((w.bounds.y + w.bounds.height - h.monitor.y) * k));
  const r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (r.width < minSide || r.height < minSide) return null;
  if (click && !pointInRect(click, r)) return null;
  return r;
}
function recordingFolderName(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `Recording_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}`;
}
function recordingTitle(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const z = (n) => String(n).padStart(2, "0");
  return `Recording, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} at ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function windowLabel(w) {
  if (!w) return "";
  const app = (w.appName || "").replace(/\.exe$/i, "").trim();
  const title = (w.title || "").trim();
  if (!title) return app;
  if (!app || title.toLowerCase().includes(app.toLowerCase())) return title;
  return `${app} - ${title}`;
}
const RATE = 16e3;
const SOUND_LEVEL$1 = 0.01;
const SILENT_AFTER_MS = 6e3;
function encodeWav(chunks, frames) {
  const out = new Uint8Array(44 + frames * 2);
  const v = new DataView(out.buffer);
  const str = (o2, s) => {
    for (let i = 0; i < s.length; i++) out[o2 + i] = s.charCodeAt(i);
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + frames * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, frames * 2, true);
  let o = 44;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o);
    o += c.byteLength;
  }
  return out;
}
async function listMicrophones() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput" && d.label && d.deviceId !== "default" && d.deviceId !== "communications").map((d) => d.label);
  } catch {
    return [];
  }
}
class MicRecorder {
  ctx = null;
  stream = null;
  node = null;
  chunks = [];
  frames = 0;
  startedAt = 0;
  firstPerf = 0;
  peak = 0;
  loudAt = 0;
  silent = false;
  device = "";
  flushed = null;
  /** @returns the microphone's name */
  async start(deviceLabel, onSilence) {
    let deviceId;
    if (deviceLabel) deviceId = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label === deviceLabel)?.deviceId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...deviceId ? { deviceId: { exact: deviceId } } : {}, channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
    });
    const track = this.stream.getAudioTracks()[0];
    this.device = track?.label || "microphone";
    const inputLatencyMs = Math.max(0, Number((track?.getSettings()).latency || 0) * 1e3);
    this.ctx = new AudioContext({ sampleRate: RATE });
    await this.ctx.audioWorklet.addModule(new URL("/worklets/pcm-capture.js", location.href).href);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.loudAt = performance.now();
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "start" && this.ctx) {
        const ts = this.ctx.getOutputTimestamp();
        const ctxSec = (m.frame || 0) / this.ctx.sampleRate;
        const perf = ts.performanceTime && ts.contextTime !== void 0 ? ts.performanceTime + (ctxSec - ts.contextTime) * 1e3 : performance.now() - 4096 / RATE * 1e3;
        this.firstPerf = perf - inputLatencyMs;
        this.startedAt = performance.timeOrigin + this.firstPerf;
      } else if (m.type === "data" && m.samples) {
        const s = m.samples;
        let sum = 0;
        const pcm = new Int16Array(s.length);
        for (let i = 0; i < s.length; i++) {
          const x = Math.max(-1, Math.min(1, s[i]));
          sum += x * x;
          pcm[i] = x < 0 ? x * 32768 : x * 32767;
        }
        this.chunks.push(pcm);
        this.frames += s.length;
        const level = Math.sqrt(sum / s.length);
        this.peak = Math.max(this.peak, level);
        if (level > SOUND_LEVEL$1) this.loudAt = performance.now();
        const silent = performance.now() - this.loudAt >= SILENT_AFTER_MS;
        if (silent !== this.silent) {
          this.silent = silent;
          onSilence(silent, this.device);
        }
      } else if (m.type === "flushed") {
        this.flushed?.();
      }
    };
    return this.device;
  }
  async stop() {
    if (this.node) {
      await Promise.race([
        new Promise((resolve) => {
          this.flushed = resolve;
          this.node.port.postMessage("flush");
        }),
        new Promise((r) => setTimeout(r, 1e3))
      ]);
    }
    const stopPerf = performance.now();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {
    });
    const result = {
      wav: encodeWav(this.chunks, this.frames),
      startedAt: this.startedAt || Date.now() - this.frames / RATE * 1e3,
      durationMs: this.firstPerf ? stopPerf - this.firstPerf : this.frames / RATE * 1e3,
      audioMs: this.frames / RATE * 1e3,
      peakLevel: this.peak,
      device: this.device
    };
    this.chunks = [];
    this.ctx = null;
    this.stream = null;
    this.node = null;
    return result;
  }
}
const DESKTOP_KEY = "dtDesktopSettings";
const DEFAULT_DESKTOP = {
  captureScope: "window",
  dwellSeconds: 7,
  whisperCli: "",
  whisperModel: "",
  stopShortcut: "CommandOrControl+Shift+S",
  autoExport: true
};
function loadDesktopSettings() {
  try {
    const s = { ...DEFAULT_DESKTOP, ...JSON.parse(localStorage.getItem(DESKTOP_KEY) || "{}") };
    // Transcription always runs on this computer (whisper.cpp); an old cloud choice is dropped.
    delete s.transcription;
    // Windows "Copy as path" wraps paths in quotes: removed here too.
    s.whisperCli = String(s.whisperCli || "").replace(/"/g, "").trim();
    s.whisperModel = String(s.whisperModel || "").replace(/"/g, "").trim();
    return s;
  } catch {
    return { ...DEFAULT_DESKTOP };
  }
}
function saveDesktopSettings(patch) {
  const next = { ...loadDesktopSettings(), ...patch };
  localStorage.setItem(DESKTOP_KEY, JSON.stringify(next));
  return next;
}
const SPECIAL = /^\s*(\[_[^\]]*\]|<\|[^|]*\|>)\s*$/;
const bare = (s) => s.replace(/[^\p{L}\p{N}'’-]+/gu, "").replace(/^[-'’]+|[-'’]+$/g, "");
function whisperCppToVerbose(json) {
  const list = Array.isArray(json?.transcription) ? json.transcription : [];
  const segments = [];
  const words = [];
  let duration = 0;
  list.forEach((seg) => {
    const text = String(seg?.text ?? "").trim();
    const from = Number(seg?.offsets?.from ?? 0) / 1e3;
    const to = Number(seg?.offsets?.to ?? seg?.offsets?.from ?? 0) / 1e3;
    duration = Math.max(duration, to);
    if (!text || SPECIAL.test(text)) return;
    let current = null;
    const flush = () => {
      if (!current) return;
      const word = bare(current.raw);
      if (word) words.push({ word, start: current.start, end: Math.max(current.end, current.start) });
      current = null;
    };
    const probs = [];
    for (const tok of seg.tokens || []) {
      const t = String(tok?.text ?? "");
      if (!t || SPECIAL.test(t)) continue;
      if (Number.isFinite(tok.p)) probs.push(Math.max(1e-6, Number(tok.p)));
      const ts = Number(tok?.offsets?.from ?? 0) / 1e3;
      const te = Number(tok?.offsets?.to ?? tok?.offsets?.from ?? 0) / 1e3;
      if (/^\s/.test(t) || !current) {
        flush();
        current = { raw: t, start: ts, end: te };
      } else {
        current.raw += t;
        current.end = Math.max(current.end, te);
      }
    }
    flush();
    const out = { id: segments.length, start: from, end: to, text };
    if (probs.length) out.avg_logprob = probs.reduce((a, p) => a + Math.log(p), 0) / probs.length;
    segments.push(out);
  });
  return { text: segments.map((s) => s.text).join(" "), duration, segments, words };
}
const SOUND_LEVEL = 0.01;
const baseName = (p) => p.split(/[\\/]/).pop() || p;
async function transcribeAndAlign(sessionId) {
  const c = await loadCore();
  const session = await c.store.getSession(sessionId);
  const audio = session?.desktopAudio;
  if (!audio) return { ok: true, skipped: true };
  const fail = async (error) => {
    await c.store.updateSession(sessionId, { voiceStatus: "error", voiceError: error });
    return { ok: false, error };
  };
  if (!(audio.peakLevel >= SOUND_LEVEL / 5)) {
    return fail(`The microphone recorded only silence${audio.device ? ` from "${audio.device}"` : ""}. Check it is connected and not muted, then record again.`);
  }
  const ds = loadDesktopSettings();
  const vs = await c.voiceSettings.loadVoiceSettings();
  const steps = await c.store.getSteps(sessionId, { withImages: false });
  const prompt = c.transcriber.vocabularyPrompt(steps);
  await c.store.updateSession(sessionId, { voiceStatus: "transcribing", voiceError: null });
  let data;
  let by;
  try {
    // Transcribed on this computer by whisper.cpp; the audio never leaves it.
    if (!ds.whisperCli || !ds.whisperModel) return fail('Transcription is not set up: choose whisper-cli and a ggml model in Settings > Voice narration, then click "Transcribe again".');
    data = whisperCppToVerbose(JSON.parse(await dt.ai.whisperLocal({ cli: ds.whisperCli, model: ds.whisperModel, wavRel: audio.rel, prompt })));
    by = `whisper.cpp:${baseName(ds.whisperModel)}`;
  } catch (err) {
    return fail(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").slice(0, 300));
  }
  const scale = c.align.driftScale(audio.durationMs, audio.audioMs);
  const phrases = c.align.phrasesFromWhisper(c.transcriber.reliableSegments(data.segments, prompt), audio.startedAt, { words: data.words, scale });
  if (!phrases.length) return fail("The narration contains no recognizable speech.");
  const clf = await classifier();
  const scrubbed = phrases.map((p) => ({
    startMs: p.startMs,
    endMs: p.endMs,
    text: c.scrubber.scrubTextSync(p.text, clf).text,
    ...p.exact ? { exact: true } : {}
  }));
  await c.store.updateSession(sessionId, {
    voiceStatus: "transcribed",
    voiceError: null,
    narrationPhrases: scrubbed,
    transcript: c.scrubber.scrubTextSync(phrases.map((p) => p.text).join(" "), clf).text,
    transcribedBy: by,
    voiceSync: [{ part: 0, driftScale: Number(scale.toFixed(5)), phrases: scrubbed.length }]
  });
  const res = await c.transcriber.alignSession(sessionId, { matching: vs.matching || "smart" });
  return res.ok ? { ok: true } : fail(res.error);
}
async function guideMarkdown(sessionId) {
  const c = await loadCore();
  const manifest = await c.store.buildManifest(sessionId);
  return c.markdown.manualMarkdown(manifest).replaceAll("](steps/", "](");
}
async function guideHtml(sessionId) {
  const c = await loadCore();
  const session = await c.store.getSession(sessionId);
  const steps = await c.store.getSteps(sessionId, { withImages: true });
  const withImages = await Promise.all(steps.map(async (s) => ({
    ...s,
    imageSrc: s.status === "redacted" && s.redactedBlob instanceof Blob ? await c.shared.blobToDataUrl(s.redactedBlob) : null
  })));
  return c.guideExport.guideHtml(session, withImages);
}
async function exportGuide(sessionId) {
  const c = await loadCore();
  const session = await c.store.getSession(sessionId);
  const folder = session?.saveFolderName;
  if (!folder) throw new Error("This recording has no folder.");
  const steps = await c.store.getSteps(sessionId, { withImages: true });
  const images = [];
  for (const s of steps) {
    if (s.status === "redacted" && s.redactedBlob instanceof Blob) {
      await dt.files.save(`${folder}/${s.redactedImageFileName}`, new Uint8Array(await s.redactedBlob.arrayBuffer()));
      images.push(s.redactedImageFileName);
    }
  }
  // Screenshots of steps that were deleted (or numbers left over after a reorder) go to the Recycle Bin.
  await dt.files.pruneSteps(folder, images);
  const manifest = await c.store.buildManifest(sessionId);
  manifest.generator = "DOCTrace Desktop";
  manifest.narrationAudio = session.desktopAudio ? "narration.wav" : null;
  await dt.files.save(`${folder}/manual_manifest.json`, JSON.stringify(manifest, null, 2));
  await dt.files.save(`${folder}/manual.md`, await guideMarkdown(sessionId));
  await dt.files.save(`${folder}/manual.html`, await guideHtml(sessionId));
  await c.store.updateSession(sessionId, { exportedAt: Date.now() });
  return folder;
}
const WRITTEN = ["manualTitle", "manualDescription", "manualUiLandmarks", "manualScreenContext", "manualExpectedOutcome", "manualNote"];
async function editStep(sessionId, stepNumber, edit) {
  const c = await loadCore();
  const patch = { ...edit };
  if (edit.scrubbedOcrText !== void 0) patch.scrubbedOcrText = await scrub(edit.scrubbedOcrText);
  if (edit.narration !== void 0) patch.narrationEdited = true;
  if (WRITTEN.some((k) => k in edit)) patch.descriptionSource = "user";
  return c.store.updateStep(sessionId, stepNumber, patch);
}
async function rewriteStepOrder(sessionId, order) {
  const c = await loadCore();
  const steps = await c.store.getSteps(sessionId, { withImages: true });
  const byNumber = new Map(steps.map((s) => [s.stepNumber, s]));
  const kept = order.map((n) => byNumber.get(n)).filter(Boolean);
  const db = await c.store.openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(c.store.STEPS, "readwrite");
    const os = tx.objectStore(c.store.STEPS);
    for (const s of steps) os.delete([sessionId, s.stepNumber]);
    kept.forEach((s, i) => {
      const n = i + 1;
      // Each step keeps its click time, and narration is matched by time, so "Transcribe again"
      // still gives every step its own words after a move. Only hand-edited narration stays frozen.
      os.put({ ...s, stepNumber: n, redactedImageFileName: s.status === "redacted" ? `step_${n}.png` : null, narrationEdited: Boolean(s.narrationEdited) });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const session = await c.store.updateSession(sessionId, { totalSteps: kept.length, failedSteps: kept.filter((s) => s.status !== "redacted").length });
  // Files already saved for this guide are rewritten at once, so the folder never keeps
  // screenshots that no longer match a step (stale ones go to the Recycle Bin).
  if (session?.exportedAt && session.saveFolderName) await exportGuide(sessionId);
}
async function moveStep(sessionId, stepNumber, delta) {
  const c = await loadCore();
  const nums = (await c.store.getSteps(sessionId, { withImages: false })).map((s) => s.stepNumber);
  const i = nums.indexOf(stepNumber);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= nums.length) return;
  [nums[i], nums[j]] = [nums[j], nums[i]];
  await rewriteStepOrder(sessionId, nums);
}
async function deleteStep(sessionId, stepNumber) {
  const c = await loadCore();
  const nums = (await c.store.getSteps(sessionId, { withImages: false })).map((s) => s.stepNumber);
  await rewriteStepOrder(sessionId, nums.filter((n) => n !== stepNumber));
}
const IDLE = { phase: "idle", sessionId: null, folder: null, startedAt: null, captured: 0, processed: 0, voice: false, micSilent: false, micDevice: "", message: "" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
class DesktopRecorder {
  state = { ...IDLE };
  captureChain = Promise.resolve();
  pushChain = Promise.resolve();
  nextStep = 1;
  lastExternal = null;
  mic = null;
  wired = false;
  /** Hook up main-process and UI events once (called by the guides window at start-up). */
  wire() {
    if (this.wired) return;
    this.wired = true;
    dt.events.on("dt:click", (e) => void this.trigger({ kind: "click", ...e }));
    dt.events.on("dt:dwell", (e) => void this.trigger({ kind: "observe", ...e }));
    dt.events.on("dt:stop", () => void this.stop());
    dt.events.on("dt:toggle", () => void this.toggle());
    dt.events.on("dt:pill", (e) => {
      if (e.cmd === "start") void this.start();
      else if (e.cmd === "stop") void this.stop();
      else if (e.cmd === "hello") this.broadcast();
      else if (e.cmd === "guides") void dt.windows.showGuides();
    });
    onCoreMessage("SC_STEP_DONE", (m) => {
      if (m.sessionId === this.state.sessionId) this.set({ processed: this.state.processed + 1 });
    });
  }
  toggle() {
    if (this.state.phase === "recording") return this.stop();
    if (this.state.phase === "idle" || this.state.phase === "error") return this.start();
    return void 0;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.broadcast();
  }
  broadcast() {
    dt.events.emit("dt:state", this.state);
  }
  async start() {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    // Every start-up step has a time limit and shows what it is doing, so a
    // step that never answers gives a clear error instead of "Starting..." forever.
    const step = (label, promise, ms = 15e3) => {
      this.set({ phase: "starting", message: `Starting: ${label}...` });
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not respond within ${ms / 1e3} s.`)), ms);
        })
      ]).finally(() => clearTimeout(timer));
    };
    this.set({ ...IDLE, phase: "starting", message: "Starting..." });
    try {
      const c = await step("loading DOCTrace", loadCore(), 3e4);
      const ds = loadDesktopSettings();
      const vs = await step("reading settings", c.voiceSettings.loadVoiceSettings());
      const folder = await step("creating the recording folder", dt.files.makeRecordingDir(recordingFolderName(/* @__PURE__ */ new Date())));
      const startedAt = Date.now();
      const { sessionId } = await step("opening the guide database", c.recorder.startSession({ startTime: startedAt, source: "desktop" }), 3e4);
      await c.store.updateSession(sessionId, { sessionTitle: recordingTitle(new Date(startedAt)), saveToFolder: true, saveFolderName: folder, platform: "desktop" });
      this.nextStep = 1;
      this.lastExternal = null;
      let voice = false;
      let micDevice = "";
      // The microphone is recorded only after the user ticked "Record my voice" and
      // saved Settings (voiceSettings.js keeps that off by default).
      if (vs.enabled) {
        const mic = new MicRecorder();
        const opening = mic.start(vs.deviceLabel || "", (silent, device) => this.set({ micSilent: silent, micDevice: device }));
        try {
          micDevice = await step("opening the microphone", opening, 1e4);
          this.mic = mic;
          voice = true;
          await c.store.updateSession(sessionId, { voice: true, voiceStatus: "recording", voiceDevice: micDevice });
        } catch (err) {
          // A microphone that hangs or fails must not block the recording: record without voice.
          opening.then(() => mic.stop(), () => {}).catch(() => {});
          this.mic = null;
          await c.store.updateSession(sessionId, { voice: false, voiceStatus: "error", voiceError: `Microphone: ${errText(err)} This recording has no voice. Check the microphone in Settings (or untick "Record my voice").` });
        }
      }
      await step("starting the click recorder", dt.input.start({ dwellMs: Math.max(0, ds.dwellSeconds) * 1e3, debounceMs: 350 }));
      const shortcutOk = await step("registering the stop shortcut", dt.shortcut.setStop(ds.stopShortcut), 5e3).catch(() => false);
      await step("showing the recorder bar", (async () => { await dt.windows.minimizeGuides(); await dt.windows.showPill(); })(), 5e3).catch(() => {});
      this.set({ phase: "recording", sessionId, folder, startedAt, voice, micDevice, message: shortcutOk === false ? "Stop shortcut unavailable: use the Stop button." : "" });
    } catch (err) {
      await dt.input.stop().catch(() => {
      });
      if (this.mic) {
        await this.mic.stop().catch(() => {
        });
        this.mic = null;
      }
      this.set({ phase: "error", message: errText(err) });
    }
  }
  async stop() {
    if (this.state.phase !== "recording") return;
    const sessionId = this.state.sessionId;
    const folder = this.state.folder;
    this.set({ phase: "stopping", message: "Capturing the final screen..." });
    const c = await loadCore();
    await dt.shortcut.setStop(null);
    await this.trigger({ kind: "complete", timestamp: Date.now() }, { force: true });
    await dt.input.stop().catch(() => {
    });
    if (this.mic) {
      try {
        const r = await this.mic.stop();
        const rel = `${folder}/narration.wav`;
        await dt.files.save(rel, r.wav);
        const audio = { rel, startedAt: r.startedAt, durationMs: r.durationMs, audioMs: r.audioMs, peakLevel: r.peakLevel, device: r.device };
        await c.store.updateSession(sessionId, { desktopAudio: audio, voiceStatus: "recorded" });
      } catch (err) {
        await c.store.updateSession(sessionId, { voiceStatus: "error", voiceError: errText(err) });
      }
      this.mic = null;
    }
    await this.captureChain;
    await this.pushChain;
    this.set({ phase: "processing", message: "Protecting the last screenshots..." });
    try {
      await c.recorder.endSession({ sessionId, endTime: Date.now() });
      await this.process(sessionId);
      this.set({ ...IDLE, message: "Guide ready." });
      await dt.windows.showGuides();
      dt.events.emit("dt:open-session", { sessionId });
    } catch (err) {
      this.set({ ...IDLE, phase: "error", message: errText(err) });
    }
  }
  /** Narration -> guide text -> files. */
  async process(sessionId) {
    const c = await loadCore();
    const session = await c.store.getSession(sessionId);
    let fresh = false;
    if (session?.desktopAudio) {
      this.set({ message: "Transcribing your narration..." });
      fresh = (await transcribeAndAlign(sessionId)).ok;
    }
    // Show progress while the guide is written. A model on a laptop CPU needs
    // minutes per step; without this the screen looks frozen.
    const t0 = Date.now();
    let progress = null;
    const show = () => {
      const min = Math.floor((Date.now() - t0) / 6e4);
      const count = progress?.total ? ` ${progress.done} of ${progress.total} steps done` : "";
      this.set({ message: `Writing the guide...${count} (${min} min)` });
    };
    const off = onCoreMessage("SC_MANUAL_UPDATED", (m) => {
      if (m?.sessionId && m.sessionId !== sessionId) return;
      void c.store.getSession(sessionId).then((s) => {
        progress = s?.manualProgress || progress;
        show();
      }).catch(() => {});
    });
    const tick = setInterval(show, 15e3);
    show();
    try {
      await writeGuide(sessionId, { force: fresh });
    } finally {
      clearInterval(tick);
      off();
    }
    if (loadDesktopSettings().autoExport) {
      this.set({ message: "Saving manual files..." });
      await exportGuide(sessionId);
    }
  }
  trigger(t, { force = false } = {}) {
    if (!force && this.state.phase !== "recording") return Promise.resolve();
    const sessionId = this.state.sessionId;
    if (!sessionId) return Promise.resolve();
    const job = this.captureChain.then(async () => {
      let cap;
      try {
        cap = t.kind === "click" ? await dt.capture.at(t.x, t.y) : await dt.capture.active();
      } catch (err) {
        this.set({ message: `Capture failed: ${errText(err)}` });
        return;
      }
      const win = cap.header.window;
      if (t.kind === "click" && win?.isOwn) return;
      if (win && !win.isOwn) this.lastExternal = win;
      const ds = loadDesktopSettings();
      const click = t.kind === "click" ? hookToImage({ x: t.x, y: t.y }, cap.header) : null;
      const shown = win && !win.isOwn ? win : this.lastExternal;
      const crop = ds.captureScope === "window" ? windowCrop({ ...cap.header, window: shown }, click) : null;
      const imageBlob = await bgraToPng(cap, crop);
      cap.bgra = new Uint8Array(0);
      const stepNumber = this.nextStep++;
      this.set({ captured: this.state.captured + 1 });
      const frame = {
        sessionId,
        stepNumber,
        timestamp: t.timestamp,
        actionType: t.kind,
        clickCoords: click ? { x: click.x - (crop?.x || 0), y: click.y - (crop?.y || 0) } : null,
        coordSpace: "image",
        dpr: cap.header.scaleFactor || 1,
        pageTitle: windowLabel(shown),
        url: "",
        targetLabel: "",
        // no DOM here: the guide uses the OCR text under the click (clickedText)
        dwellTimeMs: t.kind === "observe" ? t.idleMs ?? null : null,
        imageBlob
      };
      this.pushChain = this.pushChain.then(() => this.push(frame));
    });
    this.captureChain = job.catch(() => {
    });
    return job;
  }
  async push(frame) {
    const c = await loadCore();
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await c.recorder.enqueueFrame(frame);
        return;
      } catch (err) {
        const e = err;
        if (e.code === "QUEUE_FULL") {
          await sleep(e.retryAfterMs || 1500);
          continue;
        }
        this.set({ message: `Step ${frame.stepNumber} was not saved: ${e.message || e}` });
        return;
      }
    }
  }
}
const recorder = new DesktopRecorder();
let ready = null;
function initEngine() {
  if (!ready) {
    ready = (async () => {
      await installDesktopHost();
      await recorder.wire();
    })();
  }
  return ready;
}
const FIELDS = [
  { key: "manualTitle", label: "Step title", rows: 1 },
  { key: "manualDescription", label: "Instruction", rows: 2 },
  { key: "manualUiLandmarks", label: "Where to find it", rows: 2 },
  { key: "manualScreenContext", label: "Screen context", rows: 2 },
  { key: "manualExpectedOutcome", label: "Expected outcome", rows: 2 },
  { key: "narration", label: "Spoken narration", rows: 2, quote: true }
];
function GuideEditor({ sessionId, onChanged, onDeleted }) {
  const [session, setSession] = reactExports.useState(null);
  const [steps, setSteps] = reactExports.useState([]);
  const [busy, setBusy] = reactExports.useState("");
  const [note, setNote] = reactExports.useState("");
  const urls = reactExports.useRef([]);
  const reload = reactExports.useCallback(async () => {
    const c = await loadCore();
    const [s, list] = await Promise.all([c.store.getSession(sessionId), c.store.getSteps(sessionId, { withImages: true })]);
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current = [];
    setSession(s);
    setSteps(list.map((st) => {
      const src = st.redactedBlob instanceof Blob ? URL.createObjectURL(st.redactedBlob) : null;
      if (src) urls.current.push(src);
      return { ...st, src, redactedBlob: void 0 };
    }));
  }, [sessionId]);
  reactExports.useEffect(() => {
    void reload();
    return () => urls.current.forEach((u) => URL.revokeObjectURL(u));
  }, [reload]);
  const run = async (label, fn, done = "") => {
    setBusy(label);
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setNote(String(err?.message || err));
    }
    setBusy("");
    await reload();
    onChanged();
  };
  const exportPdf = (folder2) => run("Making the PDF...", async () => {
    await exportGuide(sessionId);
    await dt.exportPdf(`${folder2}/manual.html`, `${folder2}/manual.pdf`);
  }, `Saved ${folder2}/manual.pdf`);
  if (!session) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "empty", children: "Loading..." });
  const folder = session.saveFolderName;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "editor", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "editor-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "title",
          defaultValue: session.sessionTitle,
          "aria-label": "Guide title",
          onBlur: async (e) => {
            if (e.target.value === session.sessionTitle) return;
            const c = await loadCore();
            await c.store.updateSession(sessionId, { sessionTitle: await scrub(e.target.value) });
            onChanged();
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "meta", children: [
        steps.length,
        " steps · ",
        new Date(session.startTime).toLocaleString(),
        session.manualGeneratedBy && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          " · written by ",
          session.manualGeneratedBy
        ] }),
        session.voiceStatus && session.voiceStatus !== "off" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          " · voice: ",
          session.voiceStatus,
          session.transcribedBy ? ` (${session.transcribedBy})` : ""
        ] })
      ] }),
      session.voiceError && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "warn small", children: session.voiceError }),
      session.manualError && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "warn small", children: session.manualError }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { disabled: !!busy, onClick: () => run("Writing the guide...", () => writeGuide(sessionId, { force: true }), "Guide written."), children: "Write guide with AI" }),
        session.desktopAudio && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { disabled: !!busy, onClick: () => run("Transcribing...", async () => {
          const r = await transcribeAndAlign(sessionId);
          if (!r.ok) throw new Error(r.error);
        }, "Narration matched to steps."), children: "Transcribe again" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { disabled: !!busy || !folder, onClick: () => run("Saving files...", () => exportGuide(sessionId), `Saved to the recordings folder (${folder}). Click "Open folder" to see the files.`), children: "Save to folder" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { disabled: !folder, onClick: () => dt.files.openFolder(folder), children: "Open folder" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { disabled: !!busy || !folder, onClick: () => folder && exportPdf(folder), children: "Export to PDF" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: async () => {
          await dt.clipboard(await guideMarkdown(sessionId));
          setNote("Markdown copied.");
        }, children: "Copy Markdown" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "danger", disabled: !!busy, onClick: async () => {
          if (!confirm(`Delete this guide?${folder ? ` Its folder "${folder}" (screenshots, manual files and the voice recording narration.wav) is moved to the Recycle Bin.` : ""}`)) return;
          try {
            // Files first: if they cannot be moved, the guide stays so nothing is left behind unseen.
            if (folder) await dt.files.trashRecording(folder);
            const c = await loadCore();
            await c.store.deleteSession(sessionId);
            onDeleted();
          } catch (err) {
            setNote(`Not deleted: ${errText(err)} Close any program that has a file from this folder open, then try again.`);
          }
        }, children: "Delete" })
      ] }),
      (busy || note) && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "status small", children: busy || note }),
      session.narrationIntro && /* @__PURE__ */ jsxRuntimeExports.jsxs("blockquote", { className: "said", children: [
        '"',
        session.narrationIntro,
        '"'
      ] })
    ] }),
    steps.map((s, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: `step ${s.action === "complete" ? "final" : ""}`, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "step-head", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "num", children: s.stepNumber }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "kind", children: [
          s.action,
          s.pageTitle ? ` · ${s.pageTitle}` : ""
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "grow" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { title: "Move up", disabled: i === 0, onClick: () => run("", () => moveStep(sessionId, s.stepNumber, -1)), children: "↑" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { title: "Move down", disabled: i === steps.length - 1, onClick: () => run("", () => moveStep(sessionId, s.stepNumber, 1)), children: "↓" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { title: "Rewrite this step with AI", disabled: !!busy || s.status !== "redacted", onClick: () => run("Rewriting step...", () => rewriteStep(sessionId, s.stepNumber)), children: "Rewrite" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { title: "Delete step", className: "danger", onClick: () => confirm(`Delete step ${s.stepNumber}?`) && run("", () => deleteStep(sessionId, s.stepNumber)), children: "✕" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "step-body", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("figure", { children: [
          s.src ? /* @__PURE__ */ jsxRuntimeExports.jsx("img", { src: s.src, alt: `Step ${s.stepNumber}, sensitive information hidden` }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "missing", children: [
            "This step could not be protected, so no screenshot was kept.",
            s.error ? ` (${s.error})` : ""
          ] }),
          !!s.detectedPiiSummary?.length && /* @__PURE__ */ jsxRuntimeExports.jsxs("figcaption", { children: [
            "Hidden: ",
            s.detectedPiiSummary.join(", ")
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "fields", children: [
          FIELDS.map((f) => /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: f.quote ? "quote" : "", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: f.label }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("textarea", { rows: f.rows, defaultValue: s[f.key] || "", onBlur: (e) => {
              if ((s[f.key] || "") === e.target.value) return;
              void editStep(sessionId, s.stepNumber, { [f.key]: e.target.value }).then(() => {
                s[f.key] = e.target.value;
              });
            } })
          ] }, f.key)),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("summary", { children: "OCR text (already scrubbed)" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("textarea", { rows: 4, defaultValue: s.scrubbedOcrText || "", onBlur: (e) => {
              if ((s.scrubbedOcrText || "") !== e.target.value) void run("", () => editStep(sessionId, s.stepNumber, { scrubbedOcrText: e.target.value }));
            } })
          ] })
        ] })
      ] })
    ] }, `${s.stepNumber}-${s.frameId}`))
  ] });
}
function SettingsView() {
  const [ds, setDs] = reactExports.useState(loadDesktopSettings());
  const [ai, setAi] = reactExports.useState(null);
  const [providers, setProviders] = reactExports.useState([]);
  const [voice, setVoice] = reactExports.useState(null);
  const [devices, setDevices] = reactExports.useState([]);
  const [root2, setRoot] = reactExports.useState("");
  const [saved, setSaved] = reactExports.useState("");
  reactExports.useEffect(() => {
    void (async () => {
      const c = await loadCore();
      setAi(await loadAiChoice());
      setProviders(await providerList());
      // "Record my voice" is ticked only when the user saved it ticked (off by default).
      setVoice(await c.voiceSettings.loadVoiceSettings());
      setDevices(await listMicrophones());
      dt.files.root().then(setRoot).catch(() => {
      });
    })();
  }, []);
  if (!ai || !voice) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "empty", children: "Loading..." });
  const provider = providers.find((p) => p.id === ai.provider);
  const setD = (patch) => setDs(saveDesktopSettings(patch));
  const save = async () => {
    const c = await loadCore();
    await saveAiChoice(ai);
    // Recording the microphone is an explicit choice made here (see DesktopRecorder.start).
    await c.voiceSettings.saveVoiceSettings(voice);
    setAi(await loadAiChoice());
    setSaved("Saved.");
    setTimeout(() => setSaved(""), 2e3);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h1", { children: "Settings" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: "Capture" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Each step shows" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { value: ds.captureScope, onChange: (e) => setD({ captureScope: e.target.value }), children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "window", children: "the focused window" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "screen", children: "the whole screen" })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Observe snapshot after" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "number", min: 0, max: 60, value: ds.dwellSeconds, onChange: (e) => setD({ dwellSeconds: Number(e.target.value) }) }),
        " seconds without input (0 = off)"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Stop shortcut" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { value: ds.stopShortcut, onChange: (e) => setD({ stopShortcut: e.target.value }) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted small", children: 'The shortcut is registered only while recording, because Ctrl+Shift+S is also "Save as" in many apps.' }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Save files" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: ds.autoExport, onChange: (e) => setD({ autoExport: e.target.checked }) }),
        " write manual.md, manual.html, manual_manifest.json and PNGs when a recording ends"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted small", children: [
        "Recordings folder: ",
        root2 || "%LOCALAPPDATA%\\DOCTrace\\Recordings"
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: "Voice narration" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Record my voice" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: voice.enabled, onChange: (e) => setVoice({ ...voice, enabled: e.target.checked }) }),
        " saved as narration.wav in the recording folder (the audio itself is not scrubbed; do not say passwords out loud)"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Microphone" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { value: voice.deviceLabel || "", onChange: (e) => setVoice({ ...voice, deviceLabel: e.target.value }), children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "", children: "System default" }),
          devices.map((d) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: d, children: d }, d))
        ] }),
        !devices.length && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: async () => {
          try {
            (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
          } catch {
          }
          setDevices(await listMicrophones());
        }, children: "Show microphones" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "whisper-cli path" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { className: "wide", placeholder: "C:\\tools\\whisper\\whisper-cli.exe", value: ds.whisperCli, onChange: (e) => setD({ whisperCli: e.target.value.replace(/"/g, "") }) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Model file" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { className: "wide", placeholder: "C:\\tools\\whisper\\ggml-base.en.bin", value: ds.whisperModel, onChange: (e) => setD({ whisperModel: e.target.value.replace(/"/g, "") }) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted small", children: "Your voice is turned into text on this computer by whisper.cpp (see READ ME FIRST). Nothing is uploaded." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Match speech to steps" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { value: voice.matching || "smart", onChange: (e) => setVoice({ ...voice, matching: e.target.value }), children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "smart", children: "Smart (timing + words on screen)" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "timeWindow", children: "Strict time windows" })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: "Guide writer" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Use AI" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: ai.enabled, onChange: (e) => setAi({ ...ai, enabled: e.target.checked }) }),
        " without AI, each step gets a rule-based description"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Model" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("select", { value: ai.provider, onChange: (e) => {
          const p = providers.find((x) => x.id === e.target.value);
          setAi({ ...ai, provider: p.id, endpoint: p.endpoint, model: p.model });
        }, children: providers.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: p.id, children: p.label }, p.id)) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Endpoint" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { className: "wide", value: ai.endpoint, onChange: (e) => setAi({ ...ai, endpoint: e.target.value }) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Model name" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { className: "wide", value: ai.model, onChange: (e) => setAi({ ...ai, model: e.target.value }) })
      ] }),
      provider?.short === "LM Studio" ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted small", children: 'Runs on this computer: nothing leaves it. In LM Studio, load a model and start its local server (port 1234), then put the model\'s name above. Text only: the screenshots are not read.' }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted small", children: [
        "Runs on this computer: nothing leaves it. Install Ollama, run ",
        /* @__PURE__ */ jsxRuntimeExports.jsxs("code", { children: [
          "ollama pull ",
          ai.model
        ] }),
        " once, and set OLLAMA_CONTEXT_LENGTH=8192 (see READ ME FIRST). On a laptop without a graphics card each step can take a few minutes."
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "small", children: ai.ready ? "Ready." : ai.enabled ? ai.endpointOk === false ? "Not ready: the endpoint must be on this computer (localhost) on port 11434 (Ollama), 1234 (LM Studio) or 8080. Fix it, then Save." : "Not ready: check the model name above, then Save." : "Off." })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "save-bar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: save, children: "Save" }),
      " ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "small", children: saved })
    ] })
  ] });
}
function GuidesApp() {
  const [sessions, setSessions] = reactExports.useState([]);
  const [selected, setSelected] = reactExports.useState(null);
  const [view, setView] = reactExports.useState("guide");
  const [rec, setRec] = reactExports.useState(recorder.state);
  const refresh = reactExports.useCallback(async () => {
    const c = await loadCore();
    const list = await c.store.listSessions();
    list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    setSessions(list);
    setSelected((cur) => cur ?? list[0]?.sessionId ?? null);
  }, []);
  reactExports.useEffect(() => {
    void refresh();
    const offs = [
      dt.events.on("dt:state", (st) => {
        setRec(st);
        if (st.phase === "idle") void refresh();
      }),
      dt.events.on("dt:open-session", (e) => {
        setView("guide");
        setSelected(e.sessionId);
        void refresh();
      })
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);
  const busy = rec.phase !== "idle" && rec.phase !== "error";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "app", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "sidebar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "brand", children: [
        "DOCTrace ",
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Desktop" }),
        // The version is visible, so an older copy still running in the tray is easy to spot.
        /* @__PURE__ */ jsxRuntimeExports.jsx("small", { style: { display: "block", fontSize: "11px", opacity: 0.6, fontWeight: 400, marginTop: "2px" }, children: `version ${APP_VERSION} · offline` })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "record", disabled: busy && rec.phase !== "recording", onClick: () => recorder.toggle(), children: rec.phase === "recording" ? "■ Stop recording" : busy ? rec.message || "Working..." : "● Start recording" }),
      rec.phase === "error" && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error small", children: rec.message }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("nav", { className: "sessions", children: [
        sessions.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "button",
          {
            className: s.sessionId === selected && view === "guide" ? "active" : "",
            onClick: () => {
              setView("guide");
              setSelected(s.sessionId);
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("b", { children: s.sessionTitle || "Untitled" }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("small", { children: [
                s.totalSteps || 0,
                " steps · ",
                s.startTime ? new Date(s.startTime).toLocaleString() : ""
              ] })
            ]
          },
          s.sessionId
        )),
        !sessions.length && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted small", children: "No recordings yet. Start one, click through any app, then stop." })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: `settings-link ${view === "settings" ? "active" : ""}`, onClick: () => setView("settings"), children: "Settings" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("main", { className: "content", children: view === "settings" ? /* @__PURE__ */ jsxRuntimeExports.jsx(SettingsView, {}) : selected ? /* @__PURE__ */ jsxRuntimeExports.jsx(GuideEditor, { sessionId: selected, onChanged: refresh, onDeleted: () => {
      setSelected(null);
      void refresh();
    } }, selected) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "empty", children: "Record a workflow to create your first guide." }) })
  ] });
}
const root = createRoot(document.getElementById("root"));
initEngine().then(() => root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(GuidesApp, {}))).catch((err) => root.render(/* @__PURE__ */ jsxRuntimeExports.jsxs("pre", { className: "fatal", children: [
  "DOCTrace could not start: ",
  String(err?.stack || err)
] })));
