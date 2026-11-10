"use strict";
const electron = require("electron");
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
const allowed = new Set(EVENT_CHANNELS);
const call = (channel, ...args) => electron.ipcRenderer.invoke(channel, ...args);
const api = {
  platform: process.platform,
  input: {
    start: (opts) => call("input:start", opts),
    stop: () => call("input:stop")
  },
  capture: {
    at: (x, y) => call("capture:at", x, y),
    active: () => call("capture:active")
  },
  shortcut: { setStop: (accel) => call("shortcut:setStop", accel) },
  windows: {
    showGuides: () => call("windows:showGuides"),
    minimizeGuides: () => call("windows:minimizeGuides"),
    showPill: () => call("windows:showPill")
  },
  files: {
    root: () => call("files:root"),
    makeRecordingDir: (name) => call("files:makeRecordingDir", name),
    path: (rel) => call("files:path", rel),
    save: (rel, data) => call("files:save", rel, data),
    read: (rel) => call("files:read", rel),
    openFolder: (rel) => call("files:openFolder", rel),
    trashRecording: (name) => call("files:trashRecording", name),
    pruneSteps: (name, keep) => call("files:pruneSteps", name, keep)
  },
  ai: {
    // Only to the AI model on this computer (the main process refuses anything else).
    fetch: (req) => call("ai:fetch", req),
    whisperLocal: (opts) => call("ai:whisperLocal", opts)
  },
  exportPdf: (htmlRel, pdfRel) => call("exportPdf", htmlRel, pdfRel),
  clipboard: (text) => call("clipboard", text),
  events: {
    on(channel, fn) {
      if (!allowed.has(channel)) throw new Error(`Unknown channel ${channel}`);
      const handler = (_e, payload) => fn(payload);
      electron.ipcRenderer.on(channel, handler);
      return () => {
        electron.ipcRenderer.removeListener(channel, handler);
      };
    },
    emit(channel, payload) {
      if (allowed.has(channel)) electron.ipcRenderer.send("events:emit", channel, payload);
    }
  }
};
electron.contextBridge.exposeInMainWorld("doctrace", api);
