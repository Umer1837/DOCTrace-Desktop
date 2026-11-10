# DOCTrace Desktop

**Turn what you click into a step-by-step guide, fully offline.**

DOCTrace Desktop records the steps you click through in any Windows program or
website, blacks out sensitive information on your own computer, and writes a
guide with a screenshot and an explanation for every step. You can edit the
guide and export it to PDF, HTML or Markdown.

Nothing leaves your computer. The AI that writes the guide
([Ollama](https://ollama.com) or LM Studio) and the speech-to-text
([whisper.cpp](https://github.com/ggml-org/whisper.cpp)) run on the same PC, and
DOCTrace refuses to send data anywhere else.

## Features

- **Records any app.** Each click becomes a step; pausing on a screen adds a snapshot.
- **Privacy first.** Emails, phone numbers, ID numbers (CNIC, passport, SSN and more),
  passwords, API keys, card and bank numbers are found with on-device OCR and
  blacked out before anything is saved.
- **AI-written steps, offline.** A vision model on your PC (default `qwen2.5vl:7b` in
  Ollama) reads each redacted screenshot and writes the title, instruction, where
  to find it and what happens next. Without AI, every step still gets a rule-based description.
- **Voice narration.** Talk while you record; whisper.cpp transcribes it on your PC and
  DOCTrace matches each sentence to the step it belongs to.
- **Edit and export.** Reorder, rewrite or delete steps, then save `manual.md`,
  `manual.html`, `manual.pdf` and the screenshots.

## Download and run

1. Download `DOCTrace-Desktop-3.0.0-Windows.zip` from the
   [Releases](../../releases) page and unzip it.
2. Open the `DOCTrace Desktop` folder and double-click `DOCTrace Desktop.exe`.
   Nothing is installed. The build is not code-signed, so Windows may show
   "Windows protected your PC": click **More info**, then **Run anyway**.
3. For AI-written steps and voice narration, follow
   [READ ME FIRST.txt](READ%20ME%20FIRST.txt) (about 20-30 minutes, once).

Requirements: Windows 10 or 11 (64-bit). For the AI: Ollama and about 6 GB of disk
for the model; a graphics card is optional (without one, each step takes a few minutes).

## Where guides are saved

`%LOCALAPPDATA%\DOCTrace\Recordings\Recording_YYYY-MM-DD_HH-mm\` (not synced by
OneDrive). Deleting a guide in the app moves its folder to the Recycle Bin.

## Building from source

The app is Electron; its code is in [`app-source/`](app-source) as plain files.
After a change:

```bash
node tools/check.js
```

```bash
node tools/pack-asar.js app-source "DOCTrace Desktop/resources/app.asar.unpacked" "DOCTrace Desktop/resources/app.asar"
```

`tools/check.js` runs syntax, wiring, offline and unit checks. Packing needs the
`DOCTrace Desktop` folder from the release zip (it holds the Electron runtime and
the native click hook). See [DEVELOPER-NOTES.md](DEVELOPER-NOTES.md) for the code map.

## Known limits

- Narration and screen text are read in English.
- Built on Electron 33, which is out of support; the exe is not code-signed.
- Detection can miss text it cannot read (for example text inside photos):
  check the steps before sharing a guide.
