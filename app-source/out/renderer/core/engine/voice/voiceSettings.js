// Voice narration settings (platform key-value store).
//   enabled:     record the microphone with every recording. OFF until the user
//                ticks "Record my voice" in Settings and saves.
//   deviceLabel: the microphone picked in Settings ('' = system default)
//   matching:    how spoken sentences are tied to steps (narrationAlign.js):
//     'smart'      - words, tense and "this is..." cues (best on real recordings)
//     'timeWindow' - strict: speech between click i and click i+1 belongs to step i
//
// The audio is saved as narration.wav in the recording folder and transcribed on
// this computer by whisper.cpp. It is the user's real voice and is NOT scrubbed;
// only the transcript is.

import { platform } from '../platform/platform.js';

export const VOICE_KEY = 'dtVoiceSettings';
export const DEFAULT_VOICE = { enabled: false, deviceLabel: '', matching: 'smart' };

const clean = (s) => ({
  enabled: Boolean(s.enabled),
  deviceLabel: typeof s.deviceLabel === 'string' ? s.deviceLabel : '',
  matching: s.matching === 'timeWindow' ? 'timeWindow' : 'smart',
});

// Earlier versions saved enabled: true by default and recorded only when a second
// flag, recordConsent, was also set (it is set when "Record my voice" is saved
// ticked). Both are read and both are written, so settings saved by any version
// never switch the microphone on by themselves.
export function normalizeVoice(saved = {}) {
  const s = clean(saved);
  return { ...s, enabled: s.enabled && saved.recordConsent === true };
}

export async function loadVoiceSettings() {
  const data = await platform.kv.get(VOICE_KEY);
  return normalizeVoice(data[VOICE_KEY] || DEFAULT_VOICE);
}

export async function saveVoiceSettings(patch) {
  const next = clean({ ...(await loadVoiceSettings()), ...patch });
  await platform.kv.set({ [VOICE_KEY]: { ...next, recordConsent: next.enabled } });
  return next;
}
