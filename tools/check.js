// Checks for app-source/ before packing. No dependencies: node tools/check.js
//   1. every .js file parses
//   2. every engine module links (imports resolve, imported names exist)
//   3. windows <-> preload <-> main: every API and IPC channel used exists
//   4. offline + wording rules (no cloud hosts, no LMS/university terms)
//   5. unit tests of settings, voice settings, prompts, AI clients, narration
//      matching and the main process (URL rule, folders, Recycle Bin)
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..", "app-source");
const OUT = path.join(ROOT, "out");
const ENGINE = path.join(OUT, "renderer", "core", "engine");
let failed = 0;
let passed = 0;
const ok = (cond, name, detail = "") => {
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};
const read = (p) => fs.readFileSync(p, "utf8");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["vendor", "node_modules"].includes(e.name)) walk(p, out); } else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const jsFiles = files.filter((f) => f.endsWith(".js"));
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

async function main() {
  // ---------- 1. syntax ----------
  for (const f of jsFiles) {
    const src = read(f);
    const esm = /^\s*(import|export)\s/m.test(src);
    try {
      execFileSync(process.execPath, [esm ? "--input-type=module" : "--input-type=commonjs", "--check"], { input: src, stdio: ["pipe", "ignore", "pipe"] });
      passed++;
    } catch (e) {
      ok(false, `syntax ${rel(f)}`, String(e.stderr || e.message).split("\n").slice(0, 4).join(" "));
    }
  }

  // ---------- 2. engine modules link ----------
  const engineModules = walk(ENGINE).filter((f) => f.endsWith(".js") && !/ocr[\\/]tesseractOcr\.js$/.test(f));
  for (const f of engineModules) {
    try { await import(pathToFileURL(f).href); passed++; } catch (e) {
      ok(false, `link ${rel(f)}`, e.message);
    }
  }
  // tesseractOcr.js pulls in the bundled Tesseract (browser code): check its own imports only.
  for (const f of walk(ENGINE).filter((x) => x.endsWith(".js"))) {
    for (const m of read(f).matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(f), m[1] || m[2]);
      ok(fs.existsSync(target), `import target of ${rel(f)}`, m[1] || m[2]);
    }
  }

  // ---------- 3. windows <-> preload <-> main ----------
  const bundle = files.find((f) => /assets[\\/]index-[^\\/]+\.js$/.test(f));
  const pill = files.find((f) => /assets[\\/]pill-[^\\/]+\.js$/.test(f));
  const bundleSrc = read(bundle);
  for (const m of bundleSrc.matchAll(/load\("([^"]+)"\)/g)) ok(fs.existsSync(path.join(OUT, "renderer", "core", m[1])), "bundle load() path", m[1]);
  const preloadSrc = read(path.join(OUT, "preload", "index.js"));
  const mainSrc = read(path.join(OUT, "main", "index.js"));
  const channels = [...preloadSrc.matchAll(/call\("([^"]+)"/g)].map((m) => m[1]);
  for (const ch of channels) ok(mainSrc.includes(`ipcMain.handle("${ch}"`), "IPC channel handled in main", ch);
  for (const src of [bundleSrc, read(pill)]) {
    for (const m of src.matchAll(/\bdt\.(\w+)\.(\w+)\(/g)) {
      ok(new RegExp(`${m[1]}:\\s*\\{[\\s\\S]*?\\b${m[2]}(:|\\s*\\()`).test(preloadSrc), "window API exists in preload", `dt.${m[1]}.${m[2]}`);
    }
  }
  const version = JSON.parse(read(path.join(ROOT, "package.json"))).version;
  ok(bundleSrc.includes(`const APP_VERSION = "${version}"`), "APP_VERSION matches package.json", version);

  // ---------- 4. offline + wording ----------
  const CLOUD = /api\.groq\.com|googleapis\.com|api\.mistral\.ai|api\.anthropic\.com|api\.openai\.com|\bGroq\b|\bGemini\b|\bMistral\b/i;
  const WORDS = /\b(LMS|Bahria|Pehria|enrol\w*|semesters?|universit(y|ies)|challans?|courses?|academics?|Group ?[12])\b/i;
  const EXT = /\bchrome\.|service worker|offscreen document|Options page|chromeAdapter|\bscribeDB\b/i;
  for (const f of files.filter((x) => /\.(js|json|html|md|css)$/.test(x))) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      if (/CLOUD_FIELDS|openai_anthropic_key/.test(line)) return; // cleanup list / API-key detection rule
      if (CLOUD.test(line)) ok(false, "cloud service mentioned", `${rel(f)}:${i + 1}`);
      if (WORDS.test(line)) ok(false, "LMS/university wording", `${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      if (EXT.test(line)) ok(false, "Chrome extension leftover", `${rel(f)}:${i + 1}`);
    });
  }
  ok(!/https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|www\.w3\.org|reactjs\.org)/.test(bundleSrc.replace(/\/\/[^\n]*/g, "")), "guides window has no remote URL");

  // ---------- 5. unit tests ----------
  const imp = (p) => import(pathToFileURL(path.join(ENGINE, p)).href);
  const { setPlatform } = await imp("platform/platform.js");
  const store = new Map();
  const netCalls = [];
  let netReply = null;
  const events = [];
  setPlatform({
    name: "test",
    kv: {
      available: () => true,
      async get(keys) { const out = {}; for (const k of [].concat(keys)) if (store.has(k)) out[k] = structuredClone(store.get(k)); return out; },
      async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, structuredClone(v)); },
      async remove(keys) { for (const k of [].concat(keys)) store.delete(k); },
    },
    net: { fetch: async (url, init, opts) => { netCalls.push({ url, init, opts }); return netReply(url, init); } },
    events: { emit: (m) => events.push(m) },
  });

  // settings
  const S = await imp("manual_generator/settings.js");
  ok(Object.keys(S.PROVIDERS).sort().join() === "lmStudio,ollamaText,ollamaVision", "only local providers", Object.keys(S.PROVIDERS).join());
  ok(Object.values(S.PROVIDERS).every((p) => S.isAllowedEndpoint(p.endpoint)), "every preset endpoint is allowed");
  ok(S.DEFAULT_SETTINGS.provider === "ollamaVision" && S.DEFAULT_SETTINGS.enabled === false, "default: Ollama, AI off");
  const fromGroq = S.normalize({ enabled: true, provider: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "qwen/qwen3.8-27b", apiKey: "gsk_x", apiKeys: { groq: "gsk_x" }, consent: true });
  ok(fromGroq.provider === "ollamaVision" && fromGroq.enabled === false && fromGroq.endpoint.startsWith("http://localhost:11434") && !("apiKey" in fromGroq) && !("apiKeys" in fromGroq), "old Groq settings become Ollama, off, no key", JSON.stringify(fromGroq));
  ok(S.normalize({ enabled: true, provider: "ollamaVision", endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5vl:3b" }).model === "qwen2.5vl:3b", "chosen local model is kept");
  ok(S.normalize({ provider: "lmStudio", endpoint: "http://evil.example:1234/v1/chat/completions" }).endpoint === S.PROVIDERS.lmStudio.endpoint, "remote endpoint replaced by the preset");
  ok(!S.isAllowedEndpoint("http://localhost:2375/") && !S.isAllowedEndpoint("https://api.openai.com/v1") && S.isAllowedEndpoint("http://127.0.0.1:8080/v1/chat/completions"), "endpoint rule");
  ok(S.llmReady({ ...S.DEFAULT_SETTINGS, enabled: true }) && !S.llmReady({ ...S.DEFAULT_SETTINGS, enabled: true, endpoint: "https://api.groq.com/x" }), "llmReady");
  store.set("scManualSettings", { provider: "gemini", apiKey: "AIzaSECRET", consent: true });
  const loaded = await S.loadSettings();
  ok(loaded.provider === "ollamaVision" && !store.has("scManualSettings") && !JSON.stringify([...store.values()]).includes("SECRET"), "saved API keys are deleted on load", JSON.stringify([...store]));
  store.clear();

  // voice settings
  const V = await imp("voice/voiceSettings.js");
  ok(V.normalizeVoice({ enabled: true }).enabled === false, "old default enabled:true without consent stays off");
  ok(V.normalizeVoice({ enabled: true, recordConsent: true }).enabled === true, "saved 'Record my voice' stays on");
  ok((await V.loadVoiceSettings()).enabled === false, "voice off by default");
  await V.saveVoiceSettings({ enabled: true, deviceLabel: "Mic" });
  ok(store.get("dtVoiceSettings").recordConsent === true && (await V.loadVoiceSettings()).enabled === true, "saving 'Record my voice' turns it on");
  await V.saveVoiceSettings({ enabled: false });
  ok((await V.loadVoiceSettings()).enabled === false && store.get("dtVoiceSettings").recordConsent === false, "unticking turns it off");
  store.clear();

  // prompts: generic wording
  const P = await imp("manual_generator/prompts.js");
  const allPrompts = [P.SYSTEM_PROMPT, P.VISION_SYSTEM_PROMPT, P.LOCAL_VISION_SYSTEM_PROMPT, JSON.stringify(P.RICH_EXAMPLE), P.STYLE_EXAMPLE].join("\n");
  ok(!WORDS.test(allPrompts), "prompts have no LMS/university words", (allPrompts.match(WORDS) || [])[0]);
  ok(/any program or website/.test(P.SYSTEM_PROMPT) && /any program or website/.test(P.VISION_SYSTEM_PROMPT), "system prompts are general");
  const local = P.buildLocalUserPrompt({ step: { actionType: "click", pageTitle: "Notepad", textUnderClick: "File" } });
  ok(/Words at the click: "File"/.test(local), "local prompt builds");

  // AI clients
  const M = await imp("manual_generator/manualGenerator.js");
  netReply = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"steps":[{"stepNumber":1,"stepTitle":"Open File","actionInstruction":"Click File."}]}' } }] }) });
  const textAnswer = await M.callLLM({ enabled: true, provider: "ollamaText", endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b" }, { system: "s", user: "u" });
  const call = netCalls.pop();
  ok(call && call.url === "http://localhost:11434/v1/chat/completions" && !Object.keys(call.init.headers).some((h) => /auth/i.test(h)) && call.opts.timeoutMs === 600000, "text model goes through platform.net.fetch, no key, 10 min", JSON.stringify(call));
  ok(M.parseManualResponse(textAnswer, [1]).get(1)?.instruction === "Click File.", "text answer parsed");
  netReply = async () => { throw new Error("Error invoking remote method 'ai:fetch': Error: connect ECONNREFUSED 127.0.0.1:11434"); };
  const refused = await M.callLLM({ enabled: true, provider: "ollamaText", endpoint: "http://localhost:11434/v1/chat/completions", model: "m" }, { system: "s", user: "u" }).catch((e) => e.message);
  ok(/Could not reach the AI model at localhost:11434/.test(refused), "clear error when Ollama is not running", refused);
  const byOrder = M.parseManualResponse('{"stepTitle":"A","actionInstruction":"Do A."}', [4]);
  ok(byOrder.get(4)?.instruction === "Do A.", "bare one-step answer is taken in order");

  const VC = await imp("manual_generator/visionClient.js");
  const img = [{ stepNumber: 1, base64: "AAAA" }];
  const vs = { enabled: true, provider: "ollamaVision", endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5vl:7b", providerLabel: "Ollama" };
  const seen = [];
  const fake = (handler) => async (url, init) => { seen.push({ url, init }); const r = await handler(url, init); return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) }; };
  const vAnswer = await VC.callVisionModel(vs, { system: "s", user: "u", maxTokens: 450 }, img, fake(async () => ({ status: 200, body: { choices: [{ message: { content: "<think>x</think>{\"ok\":1}" } }] } })));
  ok(vAnswer === '{"ok":1}' && !("authorization" in seen[0].init.headers) && JSON.parse(seen[0].init.body).max_tokens === 450, "vision request: no key, answer cleaned", vAnswer);
  seen.length = 0;
  const found = await VC.callVisionModel({ ...vs, model: "missing:7b" }, { system: "s", user: "u" }, img, fake(async (url, init) => {
    if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "llama3.1" }, { id: "qwen2.5vl:3b" }] } };
    return JSON.parse(init.body).model === "qwen2.5vl:3b" ? { status: 200, body: { choices: [{ message: { content: "{}" } }] } } : { status: 404, body: { error: { type: "not_found_error", message: "model not found" } } };
  }));
  ok(found === "{}" && VC.getWorkingVisionModel({ ...vs, model: "missing:7b" }) === "qwen2.5vl:3b", "a missing model falls back to an installed vision model");
  const off = await VC.callVisionModel({ ...vs, enabled: false }, { system: "s", user: "u" }, img, fake(async () => ({ status: 200, body: {} }))).catch((e) => e.code);
  ok(off === "DISABLED", "AI switched off -> no request");
  ok(VC.rankVisionModels(["nomic-embed-text", "qwen2.5vl:7b", "llava:13b", "llama3.1"]).join() === "qwen2.5vl:7b,llava:13b", "vision model ranking");

  // narration matching follows click time, not step position
  const A = await imp("voice/narrationAlign.js");
  const phrases = [
    { startMs: 900, endMs: 1400, text: "Now click Reports.", exact: true },
    { startMs: 5600, endMs: 6400, text: "This shows the monthly totals.", exact: true },
    { startMs: 9100, endMs: 9600, text: "Click Export.", exact: true },
  ];
  const steps = [
    { stepNumber: 1, timestamp: 1000, action: "click", clickedText: "Reports" },
    { stepNumber: 2, timestamp: 5000, action: "click", clickedText: "Monthly" },
    { stepNumber: 3, timestamp: 9200, action: "click", clickedText: "Export" },
  ];
  const before = A.alignByMode("timeWindow", phrases, steps);
  const moved = steps.map((s) => ({ ...s, stepNumber: { 1: 3, 2: 1, 3: 2 }[s.stepNumber] })); // user moved step 3 to the top
  const after = A.alignByMode("timeWindow", phrases, moved);
  ok(after.get(3) === before.get(1) && after.get(1) === before.get(2) && after.get(2) === before.get(3), "narration stays with its own step after a move", JSON.stringify([...after]));
  const smartBefore = A.alignByMode("smart", phrases, steps);
  const smartAfter = A.alignByMode("smart", phrases, moved);
  ok(smartAfter.get(3) === smartBefore.get(1) && smartAfter.get(2) === smartBefore.get(3), "smart matching too");

  // main process, run with a stand-in for Electron
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctrace-check-"));
  const trashed = [];
  const electronStub = {
    app: {
      getPath: (n) => path.join(tmp, n === "documents" ? "Documents" : "userData"),
      requestSingleInstanceLock: () => false, quit() {}, on() {}, whenReady: () => new Promise(() => {}), getAppPath: () => ROOT,
    },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    shell: { trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); }, openPath: async () => "" },
    screen: {}, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle() {}, on() {} }, globalShortcut: {}, nativeImage: {}, Tray: function () {}, Menu: {}, desktopCapturer: {}, session: {}, net: {}, clipboard: {},
  };
  const fakeProcess = { ...process, platform: "win32", env: { ...process.env, LOCALAPPDATA: path.join(tmp, "Local") } };
  const ctx = vm.createContext({
    require: (m) => (m === "electron" ? electronStub : m === "uiohook-napi" ? { uIOhook: {} } : m === "fs-extra" ? require(path.join(ROOT, "node_modules", "fs-extra")) : require(m)),
    exports: {}, module: { exports: {} }, __dirname: path.join(OUT, "main"), process: fakeProcess, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, AbortSignal, Promise,
  });
  vm.runInContext(mainSrc, ctx, { filename: "main/index.js" });
  const g = ctx;
  ok(typeof g.checkUrl === "function", "main loads");
  const allowed = (u) => { try { g.checkUrl(u); return true; } catch { return false; } };
  ok(allowed("http://localhost:11434/v1/chat/completions") && allowed("http://127.0.0.1:1234/v1/models") && allowed("http://localhost:8080/x"), "main allows Ollama / LM Studio / llama.cpp");
  ok(!allowed("https://api.groq.com/openai/v1/chat/completions") && !allowed("https://generativelanguage.googleapis.com/v1beta") && !allowed("http://localhost:2375/") && !allowed("https://example.com/"), "main refuses internet and other local ports");
  ok(typeof g.groqTranscribe === "undefined" && !/ai:groqTranscribe/.test(mainSrc), "no Groq transcription in main");

  const root1 = await g.chooseRecordingsRoot();
  ok(root1 === path.join(tmp, "Local", "DOCTrace", "Recordings"), "new PC: recordings in LOCALAPPDATA", root1);
  fs.rmSync(path.join(tmp, "userData", "recordings-location.json"));
  fs.mkdirSync(path.join(tmp, "Documents", "DOCTrace", "Recordings", "Recording_2026-01-01_10-00"), { recursive: true });
  const root2 = await g.chooseRecordingsRoot();
  ok(root2 === path.join(tmp, "Documents", "DOCTrace", "Recordings"), "PC with older guides in Documents keeps them", root2);
  fs.rmSync(path.join(tmp, "userData", "recordings-location.json"));
  fs.rmSync(path.join(tmp, "Documents"), { recursive: true });
  await g.chooseRecordingsRoot();

  const rec = path.join(root1, "Recording_2026-11-10_09-00");
  fs.mkdirSync(rec, { recursive: true });
  for (const f of ["step_1.png", "step_2.png", "step_3.png", "manual.md", "narration.wav"]) fs.writeFileSync(path.join(rec, f), "x");
  const pruned = await g.pruneSteps("Recording_2026-11-10_09-00", ["step_1.png", "step_2.png"]);
  ok(pruned === 1 && !fs.existsSync(path.join(rec, "step_3.png")) && fs.existsSync(path.join(rec, "narration.wav")) && fs.existsSync(path.join(rec, "step_2.png")), "pruneSteps removes only stale step images");
  ok(await g.trashRecording("Recording_2026-11-10_09-00") === true && !fs.existsSync(rec) && trashed.includes(rec), "trashRecording sends the folder to the Recycle Bin");
  ok(await g.trashRecording("Recording_gone") === false, "missing folder is fine");
  for (const bad of ["..", "a/b", "..\\x", "", "C:\\Windows"]) ok(await g.trashRecording(bad).then(() => false, () => true), "refuses folder", JSON.stringify(bad));

  // aiFetch -> local server, through node:http (the path every AI request takes)
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ got: JSON.parse(b || "{}"), auth: req.headers.authorization || null })); }); });
  const port = await new Promise((resolve) => { server.once("error", () => resolve(null)); server.listen(8080, "127.0.0.1", () => resolve(8080)); });
  if (port) {
    const r = await g.aiFetch({ url: "http://127.0.0.1:8080/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: 1 }), timeoutMs: 5000 });
    ok(r.ok && JSON.parse(r.text).got.hello === 1 && JSON.parse(r.text).auth === null, "aiFetch reaches a local server", r.text);
    server.close();
  } else {
    console.log("note: port 8080 is in use, aiFetch round trip skipped");
  }
  const refusedFetch = await g.aiFetch({ url: "https://api.groq.com/openai/v1/chat/completions" }).catch((e) => e.message);
  ok(/works offline/.test(refusedFetch), "aiFetch refuses the internet", refusedFetch);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
