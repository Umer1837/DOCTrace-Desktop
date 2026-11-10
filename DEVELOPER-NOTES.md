# DOCTrace Desktop 3.0.0: developer notes

DOCTrace Desktop is an offline Electron app for Windows. It records clicks in any
program, blacks out sensitive data on the device, and writes a step-by-step guide
with an AI model that runs on the same computer (Ollama or LM Studio). Voice
narration is transcribed on the same computer by whisper.cpp.

## Folders

| Folder | What it is |
|---|---|
| `DOCTrace Desktop/` | The runnable app. `resources/app.asar` holds the code; `resources/app.asar.unpacked/` holds the native click hook (`uiohook-napi`). |
| `app-source/` | The code inside `app.asar`, as plain files. Edit here, then pack (below). |
| `tools/` | `pack-asar.js` builds `app.asar` from `app-source/`; `extract-asar.js` does the reverse; `check.js` runs the checks. |

## Code map (`app-source/`)

| Path | Role |
|---|---|
| `package.json` | Name, version (keep equal to `APP_VERSION` in the guides window bundle). |
| `out/main/index.js` | Main process: windows, tray, click hook, screen capture, files, the only network access (`aiFetch`, localhost only), whisper.cpp, PDF export, Recycle Bin. |
| `out/preload/index.js` | The `window.doctrace` API the windows may call (IPC). |
| `out/renderer/assets/index-*.js` | Guides window: recorder, guide editor, Settings, desktop host for the engine. |
| `out/renderer/assets/pill-*.js` | The small floating Record/Stop bar. |
| `out/renderer/core/engine/` | Engine (plain ES modules, loaded at run time from `app://doctrace/core/engine/...`). |
| `engine/pipeline.js`, `ocr/`, `detection/`, `redaction/`, `privacy/` | OCR (Tesseract, bundled), sensitive-data detection (regex, keywords, ML model), black boxes, text scrubbing. |
| `engine/recorder/recorderService.js` | Turns captured frames into redacted steps in IndexedDB. |
| `engine/manual_generator/` | Guide writer: `settings.js` (models), `prompts.js`, `manualGenerator.js`, `visionClient.js`, `imagePrep.js`. |
| `engine/voice/` | Voice settings, narration-to-step matching (`narrationAlign.js`, by click time). |
| `engine/storage/` | IndexedDB (`sessionStore.js`) and `manual.md` (`manualMarkdown.js`). |
| `engine/platform/platform.js` | Host contract (`kv`, `net`, `events`), installed by the guides window. |

## Offline rules

- `main/index.js` `checkUrl()` allows only `localhost` / `127.0.0.1` / `[::1]` on ports
  11434 (Ollama), 1234 (LM Studio) and 8080 (llama.cpp server). Everything else is
  refused. The windows' Content-Security-Policy (`connect-src 'self'`) blocks direct
  requests, so all AI traffic must go through `platform.net.fetch` -> `ai:fetch`.
- `whisperLocal()` runs only an absolute `whisper-cli(.exe)` / `whisper(.exe)` /
  `main(.exe)` with a `.bin` model.
- Tesseract's worker, core and English language file are bundled in `engine/vendor/tesseract/`.
- No API keys are stored. `settings.js` deletes keys and cloud settings saved by older versions.

## Storage

- Guides (steps, redacted screenshots, text): IndexedDB `docTraceDB` in
  `%APPDATA%\DOCTrace Desktop\`.
- Settings: localStorage of the guides window (`docTraceManualSettings`,
  `dtVoiceSettings`, `dtDesktopSettings`).
- Files: `%LOCALAPPDATA%\DOCTrace\Recordings\Recording_*\` by default
  (`recordings-location.json` remembers the choice; an existing
  `Documents\DOCTrace\Recordings` with guides in it is kept).
- Deleting a guide moves its folder to the Recycle Bin (`files:trashRecording`).
  Saving a guide moves `step_N.png` files that no longer belong to a step to the
  Recycle Bin (`files:pruneSteps`). Moving or deleting a step re-saves an exported guide.

## Build

```bash
node tools/check.js
```

```bash
node tools/pack-asar.js app-source "DOCTrace Desktop/resources/app.asar.unpacked" "DOCTrace Desktop/resources/app.asar"
```

Quit DOCTrace (tray icon > Quit) before packing, and start it again afterwards.

The `.exe` is the Electron 33.2.1 runtime with the RunAsNode, NODE_OPTIONS and
inspect fuses switched off. Changing the Electron version, the exe's icon/version
resource or code signing needs a full electron-builder project (not included).

## Known limits

- English only: whisper is run with `-l en`, OCR uses `eng.traineddata`.
- Electron 33 is out of support; the exe is not code-signed.
- The active window is read with a hidden PowerShell process (`-EncodedCommand`),
  which some antivirus programs flag.
