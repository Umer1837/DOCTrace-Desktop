"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("node:path");
const node_url = require("node:url");
const electron = require("electron");
const uiohookNapi = require("uiohook-napi");
const node_child_process = require("node:child_process");
const node_readline = require("node:readline");
const fs = require("fs-extra");
const os = require("node:os");
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DtWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static string Query() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "null";
    var sb = new StringBuilder(GetWindowTextLength(h) + 1);
    GetWindowText(h, sb, sb.Capacity);
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r;
    // Visible frame (without the invisible resize border), physical pixels.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return "{\"title\":" + Json(sb.ToString()) + ",\"appName\":" + Json(name) + ",\"processId\":" + pid
      + ",\"bounds\":{\"x\":" + r.L + ",\"y\":" + r.T + ",\"width\":" + (r.R - r.L) + ",\"height\":" + (r.B - r.T) + "}}";
  }
  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 32) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
}
'@
# Per-monitor DPI aware, so bounds are real pixels on scaled displays too.
try { [DtWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'exit') { break }
  try { [Console]::Out.WriteLine([DtWin]::Query()) } catch { [Console]::Out.WriteLine('null') }
}
`;
class WindowsQuery {
  ps = null;
  waiting = [];
  ready = null;
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
      const ps = node_child_process.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
      this.ps = ps;
      const rl = node_readline.createInterface({ input: ps.stdout });
      let isReady = false;
      rl.on("line", (line) => {
        if (!isReady) {
          if (line.trim() === "ready") {
            isReady = true;
            resolve();
          }
          return;
        }
        this.waiting.shift()?.(line);
      });
      ps.on("exit", () => {
        this.ps = null;
        this.ready = null;
        for (const w of this.waiting.splice(0)) w("null");
        if (!isReady) reject(new Error("PowerShell window query did not start"));
      });
      ps.on("error", reject);
    });
    return this.ready;
  }
  async query() {
    await this.start();
    const line = await new Promise((resolve) => {
      this.waiting.push(resolve);
      this.ps?.stdin.write("q\n");
    });
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  dispose() {
    try {
      this.ps?.stdin.write("exit\n");
    } catch {
    }
  }
}
const run = (cmd, args) => new Promise((resolve) => {
  node_child_process.execFile(cmd, args, { timeout: 3e3, windowsHide: true }, (err, out) => resolve(err ? "" : String(out)));
});
const MAC_SCRIPT = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set n to name of p
  set i to unix id of p
  try
    set w to front window of p
    set t to name of w
    set {x, y} to position of w
    set {ww, hh} to size of w
  on error
    set t to ""
    set {x, y, ww, hh} to {0, 0, 0, 0}
  end try
end tell
return n & tab & i & tab & t & tab & x & tab & y & tab & ww & tab & hh`;
async function macQuery() {
  const out = (await run("osascript", ["-e", MAC_SCRIPT])).trim();
  if (!out) return null;
  const [appName, pid, title, x, y, w, h] = out.split("	");
  return { appName, processId: Number(pid), title, bounds: { x: +x, y: +y, width: +w, height: +h } };
}
async function linuxQuery() {
  const id = (await run("xdotool", ["getactivewindow"])).trim();
  if (!id) return null;
  const [title, geo, pid] = await Promise.all([
    run("xdotool", ["getwindowname", id]),
    run("xdotool", ["getwindowgeometry", "--shell", id]),
    run("xdotool", ["getwindowpid", id])
  ]);
  const g = Object.fromEntries(geo.split("\n").map((l) => l.split("=")).filter((p) => p.length === 2));
  const comm = (await run("ps", ["-p", pid.trim(), "-o", "comm="])).trim();
  const k = electron.screen.getPrimaryDisplay().scaleFactor || 1;
  return { title: title.trim(), appName: comm, processId: Number(pid), bounds: { x: +g.X / k, y: +g.Y / k, width: +g.WIDTH / k, height: +g.HEIGHT / k } };
}
const windows = process.platform === "win32" ? new WindowsQuery() : null;
async function activeWindow(ownPids2) {
  let raw = null;
  try {
    raw = process.platform === "win32" ? await windows.query() : process.platform === "darwin" ? await macQuery() : await linuxQuery();
  } catch {
    raw = null;
  }
  if (!raw) return null;
  const bounds = process.platform === "win32" ? electron.screen.screenToDipRect(null, raw.bounds) : raw.bounds;
  return { ...raw, bounds, isOwn: ownPids2.has(raw.processId) };
}
function warmUpActiveWindow() {
  if (windows) void windows.query().catch(() => {
  });
}
function disposeActiveWindow() {
  windows?.dispose();
}
function largestDisplayPixels(displays) {
  let width = 0;
  let height = 0;
  for (const d of displays) {
    width = Math.max(width, Math.round(d.bounds.width * d.scaleFactor));
    height = Math.max(height, Math.round(d.bounds.height * d.scaleFactor));
  }
  return { width, height };
}
async function grab(display, ownPids2, windowInfo) {
  const win = windowInfo === void 0 ? await activeWindow(ownPids2) : windowInfo;
  const displays = electron.screen.getAllDisplays();
  const sources = await electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: largestDisplayPixels(displays) });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : sources[displays.findIndex((d) => d.id === display.id)]);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(process.platform === "darwin" ? "Screen capture is not allowed. Enable DOCTrace in System Settings > Privacy & Security > Screen Recording." : "The screen could not be captured.");
  }
  const size = source.thumbnail.getSize();
  return {
    header: { width: size.width, height: size.height, monitor: { ...display.bounds }, scaleFactor: display.scaleFactor, window: win },
    bgra: new Uint8Array(source.thumbnail.toBitmap())
  };
}
function captureAt(p, ownPids2) {
  return grab(electron.screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }), ownPids2);
}
async function captureActive(ownPids2) {
  const win = await activeWindow(ownPids2);
  const display = win && win.bounds.width > 0 ? electron.screen.getDisplayMatching({ x: Math.round(win.bounds.x), y: Math.round(win.bounds.y), width: Math.round(win.bounds.width), height: Math.round(win.bounds.height) }) : electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  return grab(display, ownPids2, win);
}
// Where recordings live: %LOCALAPPDATA%\DOCTrace\Recordings. Not Documents, which is
// often synced by OneDrive (it would upload screenshots and narration.wav) and held
// by antivirus ransomware protection / Controlled folder access.
// Decided once and remembered in recordings-location.json, so guides stay in one place.
// A PC that already keeps its guides in Documents\DOCTrace\Recordings (older
// versions) keeps using that folder, so no guide loses its files.
let recordingsRootCache = null;
const documentsRecordings = () => path.join(electron.app.getPath("documents"), "DOCTrace", "Recordings");
const localRecordings = () => path.join(process.env.LOCALAPPDATA || electron.app.getPath("userData"), "DOCTrace", "Recordings");
const locationFile = () => path.join(electron.app.getPath("userData"), "recordings-location.json");
async function canWrite(dir, ms = 4e3) {
  const probe = path.join(dir, `.doctrace-write-test-${process.pid}`);
  const work = (async () => {
    await fs.ensureDir(dir);
    await fs.writeFile(probe, "ok");
    await fs.remove(probe);
    return true;
  })().catch(() => false);
  return Promise.race([work, new Promise((r) => setTimeout(() => r(false), ms))]);
}
async function hasOldRecordings(dir) {
  try {
    return (await fs.readdir(dir)).some((name) => /^Recording_/.test(name));
  } catch {
    return false;
  }
}
async function chooseRecordingsRoot() {
  try {
    const saved = JSON.parse(await fs.readFile(locationFile(), "utf8"));
    if (saved?.root && await canWrite(saved.root)) {
      recordingsRootCache = saved.root;
      return recordingsRootCache;
    }
  } catch {
  }
  const docs = documentsRecordings();
  const keepDocs = await hasOldRecordings(docs) && await canWrite(docs);
  recordingsRootCache = keepDocs ? docs : localRecordings();
  if (!keepDocs && !await canWrite(recordingsRootCache)) recordingsRootCache = path.join(electron.app.getPath("userData"), "Recordings");
  await fs.ensureDir(recordingsRootCache).catch(() => {
  });
  await fs.outputFile(locationFile(), JSON.stringify({
    root: recordingsRootCache,
    chosenAt: (/* @__PURE__ */ new Date()).toISOString(),
    reason: keepDocs ? "guides from an older DOCTrace are already in Documents" : "default: local app data (not synced by OneDrive)"
  }, null, 2)).catch(() => {
  });
  return recordingsRootCache;
}
function recordingsRoot() {
  return recordingsRootCache || localRecordings();
}
function resolveInRoot(rel) {
  const root = recordingsRoot();
  const clean = String(rel || "").replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`Refused path: ${rel}`);
  }
  const abs = path.resolve(root, clean);
  if (!abs.startsWith(root + path.sep)) throw new Error(`Refused path: ${rel}`);
  return abs;
}
async function makeRecordingDir(name) {
  await fs.ensureDir(recordingsRoot());
  for (let i = 1; i < 1e3; i++) {
    const candidate = i === 1 ? name : `${name}_${i}`;
    const abs = resolveInRoot(candidate);
    if (!await fs.pathExists(abs)) {
      await fs.ensureDir(abs);
      return candidate;
    }
  }
  throw new Error("Could not create a recording folder");
}
async function saveFile(rel, data) {
  const abs = resolveInRoot(rel);
  await fs.outputFile(abs, typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}
async function readFile(rel) {
  return new Uint8Array(await fs.readFile(resolveInRoot(rel)));
}
async function openFolder(rel) {
  const abs = rel ? resolveInRoot(rel) : recordingsRoot();
  await fs.ensureDir(abs);
  const err = await electron.shell.openPath(abs);
  if (err) throw new Error(err);
}
// A guide's own folder (one name, directly in the recordings folder, never the folder itself).
function recordingDir(name) {
  const clean = String(name || "");
  if (!/^[^\\/:*?"<>|]+$/.test(clean) || clean === "." || clean === "..") throw new Error(`Refused folder: ${name}`);
  return resolveInRoot(clean);
}
// Deleting a guide: its folder (screenshots, manual files, narration.wav) goes to the
// Recycle Bin, so a mistake can be undone there. A folder that is already gone is fine.
async function trashRecording(name) {
  const abs = recordingDir(name);
  if (!await fs.pathExists(abs)) return false;
  await electron.shell.trashItem(abs);
  return true;
}
// Saving a guide: screenshots that no longer belong to a step (the step was deleted, or the
// steps were renumbered by a move) go to the Recycle Bin. Only step_N.png files are touched.
async function pruneSteps(name, keep) {
  const abs = recordingDir(name);
  const wanted = new Set((Array.isArray(keep) ? keep : []).map(String));
  let removed = 0;
  for (const file of await fs.readdir(abs).catch(() => [])) {
    if (!/^step_\d+\.png$/i.test(file) || wanted.has(file)) continue;
    await electron.shell.trashItem(path.join(abs, file));
    removed++;
  }
  return removed;
}
// Offline: DOCTrace only talks to the AI servers it supports on THIS computer, not to the
// internet and not to any other local service (Ollama 11434, LM Studio 1234, llama.cpp 8080).
const LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_PORTS = /* @__PURE__ */ new Set(["11434", "1234", "8080"]);
function checkUrl(url) {
  const u = new URL(url);
  const local = LOCAL_HOSTS.has(u.hostname) && LOCAL_PORTS.has(u.port) && (u.protocol === "http:" || u.protocol === "https:");
  if (!local) {
    throw new Error(LOCAL_HOSTS.has(u.hostname)
      ? `DOCTrace only talks to AI servers on this computer on ports 11434 (Ollama), 1234 (LM Studio) or 8080, not ${u.host}.`
      : `DOCTrace works offline and does not send data to ${u.host}.`);
  }
  return u;
}
// Requests go through node:http / node:https, not Node's fetch: fetch (undici) waits at
// most 300 s for the response headers, whatever the AbortSignal says, and a model on a
// CPU can need longer. DOCTrace's own timeout (up to 10 minutes) applies instead.
function localHttp(u, req, timeoutMs) {
  const http = require(u.protocol === "https:" ? "node:https" : "node:http");
  return new Promise((resolve, reject) => {
    const body = req.body == null ? null : Buffer.from(String(req.body), "utf8");
    const headers = { ...req.headers || {} };
    if (body) headers["content-length"] = String(body.length);
    const r = http.request(u, { method: req.method || "GET", headers, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const out = {};
        for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, headers: out, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
async function aiFetch(req) {
  const u = checkUrl(req.url);
  const timeoutMs = Math.min(req.timeoutMs || 12e4, 6e5);
  return localHttp(u, req, timeoutMs);
}
// The window can only ask to run whisper.cpp itself, not any program on the disk.
const WHISPER_EXE = /^(whisper-cli|whisper|main)(\.exe)?$/i;
// Windows "Copy as path" wraps paths in quotes; a real path never contains ".
const unquote = (p) => String(p ?? "").trim().replace(/"/g, "");
function whisperLocal(opts) {
  opts = { ...opts, cli: unquote(opts.cli), model: unquote(opts.model) };
  return new Promise((resolve, reject) => {
    const wav = resolveInRoot(opts.wavRel);
    for (const [what, p] of [["whisper-cli", opts.cli], ["Whisper model", opts.model], ["narration", wav]]) {
      if (!p || !fs.existsSync(p)) return reject(new Error(`${what} not found: ${p}`));
    }
    if (!path.isAbsolute(opts.cli) || !WHISPER_EXE.test(path.basename(opts.cli))) {
      return reject(new Error(`The whisper program must be whisper-cli.exe from whisper.cpp (got ${path.basename(String(opts.cli))}).`));
    }
    if (!/\.bin$/i.test(String(opts.model))) {
      return reject(new Error("The Whisper model must be a ggml .bin file, for example ggml-base.en.bin."));
    }
    const base = path.join(os.tmpdir(), `doctrace_whisper_${process.pid}_${Date.now()}`);
    const args = ["-m", opts.model, "-f", wav, "-l", "en", "-ojf", "-np", "-of", base, "-t", String(Math.max(2, Math.min(8, os.cpus().length - 1)))];
    if (opts.prompt?.trim()) args.push("--prompt", opts.prompt);
    node_child_process.execFile(opts.cli, args, { windowsHide: true, timeout: 30 * 6e4, maxBuffer: 16 * 1024 * 1024 }, async (err, _out, stderr) => {
      const jsonPath = `${base}.json`;
      try {
        if (err) return reject(new Error(`whisper-cli failed: ${String(stderr || err.message).slice(-400)}`));
        resolve(await fs.readFile(jsonPath, "utf8"));
      } catch (e) {
        reject(new Error(`whisper-cli wrote no JSON: ${e.message}`));
      } finally {
        fs.remove(jsonPath).catch(() => {
        });
      }
    });
  });
}
async function exportPdf(htmlRel, pdfRel) {
  const html = resolveInRoot(htmlRel);
  const pdf = resolveInRoot(pdfRel);
  const win = new electron.BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadFile(html);
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { marginType: "default" } });
    await fs.outputFile(pdf, data);
  } finally {
    win.destroy();
  }
  await electron.shell.openPath(pdf);
  return pdf;
}
const EVENT_CHANNELS = [
  "dt:click",
  // ClickEvent        global left click (debounced), not on a DOCTrace window
  "dt:dwell",
  // DwellEvent        no mouse/keyboard input for dwellMs
  "dt:stop",
  // -                 stop shortcut pressed
  "dt:toggle",
  // -                 tray "Start / stop recording"
  "dt:pill",
  // { cmd }           pill button -> recording engine
  "dt:state",
  // RecState          recording engine -> pill + guides UI
  "dt:open-session"
  // { sessionId }     show a guide
];
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const RENDERER_DIR = path.join(__dirname, "../renderer");
const APP_ORIGIN = "app://doctrace";
const ownPids = /* @__PURE__ */ new Set([process.pid]);
let guides = null;
let pill = null;
let tray = null;
let quitting = false;
const MIN_DEBOUNCE_MS = 350;
const DEFAULT_DWELL_MS = 7e3;
const input = {
  running: false,
  dwellMs: DEFAULT_DWELL_MS,
  debounceMs: MIN_DEBOUNCE_MS,
  lastClickAt: 0,
  lastActivityAt: Date.now(),
  armed: true,
  // one observe snapshot per still period
  timer: null
};
function activity() {
  input.lastActivityAt = Date.now();
  input.armed = true;
}
function onOwnWindow(p) {
  return electron.BrowserWindow.getAllWindows().some((w) => {
    if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) return false;
    const b = w.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  });
}
function onMouseDown(e) {
  activity();
  if (!input.running || Number(e.button) !== 1) return;
  const now = Date.now();
  if (now - input.lastClickAt < input.debounceMs) return;
  const p = electron.screen.getCursorScreenPoint();
  if (onOwnWindow(p)) return;
  input.lastClickAt = now;
  sendToGuides("dt:click", { x: p.x, y: p.y, timestamp: now });
}
function checkDwell() {
  if (!input.running || !input.armed || input.dwellMs <= 0) return;
  const idle = Date.now() - input.lastActivityAt;
  if (idle < input.dwellMs) return;
  input.armed = false;
  const p = electron.screen.getCursorScreenPoint();
  sendToGuides("dt:dwell", { x: p.x, y: p.y, timestamp: Date.now(), idleMs: idle });
}
let hookWired = false;
function startInput(dwellMs, debounceMs = MIN_DEBOUNCE_MS) {
  input.dwellMs = Math.max(0, Number(dwellMs) || 0);
  input.debounceMs = Math.max(MIN_DEBOUNCE_MS, Number(debounceMs) || 0);
  input.lastClickAt = 0;
  activity();
  if (!hookWired) {
    hookWired = true;
    uiohookNapi.uIOhook.on("mousedown", onMouseDown);
    uiohookNapi.uIOhook.on("mousemove", activity);
    uiohookNapi.uIOhook.on("wheel", activity);
    uiohookNapi.uIOhook.on("keydown", activity);
  }
  if (!input.running) {
    uiohookNapi.uIOhook.start();
    input.running = true;
  }
  input.timer ??= setInterval(checkDwell, 200);
}
function stopInput() {
  if (input.timer) {
    clearInterval(input.timer);
    input.timer = null;
  }
  if (input.running) {
    input.running = false;
    try {
      uiohookNapi.uIOhook.stop();
    } catch {
    }
  }
}
function sendToGuides(channel, payload) {
  if (guides && !guides.isDestroyed()) guides.webContents.send(channel, payload);
}
function broadcast(channel, payload) {
  for (const w of electron.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}
function pageUrl(page) {
  return DEV_URL ? `${DEV_URL}/${page}` : `${APP_ORIGIN}/${page}`;
}
const preload = path.join(__dirname, "../preload/index.js");
const hideInsteadOfClose = (w) => w.on("close", (e) => {
  if (!quitting) {
    e.preventDefault();
    w.hide();
  }
});
function createGuidesWindow() {
  guides = new electron.BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: "DOCTrace",
    show: false,
    icon: path.join(electron.app.getAppPath(), "build", "icon.png"),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The recording engine (OCR, mic) lives here and must keep running while minimized.
      backgroundThrottling: false
    }
  });
  guides.once("ready-to-show", () => guides?.show());
  hideInsteadOfClose(guides);
  void guides.loadURL(pageUrl("index.html"));
}
function createPill() {
  const area = electron.screen.getPrimaryDisplay().workArea;
  const width = 360;
  pill = new electron.BrowserWindow({
    width,
    height: 64,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  pill.setContentProtection(true);
  pill.setAlwaysOnTop(true, "screen-saver");
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideInsteadOfClose(pill);
  void pill.loadURL(pageUrl("pill.html"));
}
function showGuides() {
  if (!guides) return;
  if (guides.isMinimized()) guides.restore();
  guides.show();
  guides.focus();
}
function createTray() {
  const icon = electron.nativeImage.createFromPath(path.join(electron.app.getAppPath(), "build", "tray.png"));
  tray = new electron.Tray(icon.isEmpty() ? electron.nativeImage.createEmpty() : icon);
  tray.setToolTip("DOCTrace");
  tray.setContextMenu(electron.Menu.buildFromTemplate([
    { label: "Start / stop recording", click: () => sendToGuides("dt:toggle") },
    { label: "Open guides", click: showGuides },
    { label: "Show recorder", click: () => pill?.show() },
    { type: "separator" },
    { label: "Quit DOCTrace", click: () => {
      quitting = true;
      electron.app.quit();
    } }
  ]));
  tray.on("click", showGuides);
}
electron.protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }
]);
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' data: blob:; media-src 'self' blob:";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gz": "application/gzip",
  ".traineddata": "application/octet-stream"
};
function serveApp() {
  electron.protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response("Not found", { status: 404 });
    const res = await electron.net.fetch(node_url.pathToFileURL(file).toString()).catch(() => null);
    if (!res || !res.ok) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "Content-Security-Policy": CSP });
    headers.set("Content-Type", MIME[path.extname(file).toLowerCase()] || res.headers.get("content-type") || "application/octet-stream");
    return new Response(res.body, { status: 200, headers });
  });
}
const isOwnPage = (url) => url.startsWith(`${APP_ORIGIN}/`) || !!DEV_URL && url.startsWith(DEV_URL);
function registerIpc() {
  electron.ipcMain.handle("input:start", (_e, o) => startInput(o.dwellMs, o.debounceMs));
  electron.ipcMain.handle("input:stop", () => stopInput());
  electron.ipcMain.handle("capture:at", (_e, x, y) => captureAt({ x, y }, ownPids));
  electron.ipcMain.handle("capture:active", () => captureActive(ownPids));
  let stopAccel = null;
  electron.ipcMain.handle("shortcut:setStop", (_e, accel) => {
    if (stopAccel) {
      electron.globalShortcut.unregister(stopAccel);
      stopAccel = null;
    }
    if (!accel) return true;
    try {
      const ok = electron.globalShortcut.register(accel, () => sendToGuides("dt:stop"));
      if (ok) stopAccel = accel;
      return ok;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("windows:showGuides", () => showGuides());
  electron.ipcMain.handle("windows:minimizeGuides", () => guides?.minimize());
  electron.ipcMain.handle("windows:showPill", () => pill?.show());
  electron.ipcMain.handle("files:root", () => recordingsRoot());
  electron.ipcMain.handle("files:makeRecordingDir", (_e, name) => makeRecordingDir(name));
  electron.ipcMain.handle("files:path", (_e, rel) => resolveInRoot(rel));
  electron.ipcMain.handle("files:save", (_e, rel, data) => saveFile(rel, data));
  electron.ipcMain.handle("files:read", (_e, rel) => readFile(rel));
  electron.ipcMain.handle("files:openFolder", (_e, rel) => openFolder(rel));
  electron.ipcMain.handle("files:trashRecording", (_e, name) => trashRecording(name));
  electron.ipcMain.handle("files:pruneSteps", (_e, name, keep) => pruneSteps(name, keep));
  electron.ipcMain.handle("ai:fetch", (_e, req) => aiFetch(req));
  electron.ipcMain.handle("ai:whisperLocal", (_e, opts) => whisperLocal(opts));
  electron.ipcMain.handle("exportPdf", (_e, htmlRel, pdfRel) => exportPdf(htmlRel, pdfRel));
  electron.ipcMain.handle("clipboard", (_e, text) => electron.clipboard.writeText(String(text)));
  electron.ipcMain.on("events:emit", (_e, channel, payload) => {
    if (EVENT_CHANNELS.includes(channel)) broadcast(channel, payload);
  });
}
if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", showGuides);
  electron.app.whenReady().then(async () => {
    await chooseRecordingsRoot(); // before any window can ask for files
    serveApp();
    electron.session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      cb(["media", "clipboard-sanitized-write"].includes(permission) && isOwnPage(details.requestingUrl));
    });
    electron.session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && isOwnPage(`${origin}/`));
    registerIpc();
    createGuidesWindow();
    createPill();
    createTray();
    warmUpActiveWindow();
  });
  electron.app.on("before-quit", () => {
    quitting = true;
  });
  electron.app.on("will-quit", () => {
    stopInput();
    electron.globalShortcut.unregisterAll();
    disposeActiveWindow();
  });
  electron.app.on("window-all-closed", () => {
  });
}
exports.DEFAULT_DWELL_MS = DEFAULT_DWELL_MS;
exports.MIN_DEBOUNCE_MS = MIN_DEBOUNCE_MS;
