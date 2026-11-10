// Persistent storage for recorded guides, in the "docTraceDB" IndexedDB database
// of the guides window (inside %APPDATA%\DOCTrace Desktop).
//
// Object stores (created if missing):
//   sc_sessions  key: sessionId              one record per recording
//   sc_steps     key: [sessionId, stepNumber] one record per step, with the
//                                            REDACTED image Blob (never the raw one)
// The voice recording is not kept here: it is narration.wav in the recording folder.
//
// Adding a store needs an IndexedDB version upgrade. The database is opened at its
// CURRENT version, and only if a store is missing it is reopened at version + 1.

export const DB_NAME = 'docTraceDB';
export const SESSIONS = 'sc_sessions';
export const STEPS = 'sc_steps';

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function ensureStores(db) {
  if (!db.objectStoreNames.contains(SESSIONS)) {
    const s = db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
    s.createIndex('startTime', 'startTime');
  }
  if (!db.objectStoreNames.contains(STEPS)) {
    db.createObjectStore(STEPS, { keyPath: ['sessionId', 'stepNumber'] });
  }
}

const hasAllStores = (db) => [SESSIONS, STEPS].every((s) => db.objectStoreNames.contains(s));

function watch(db) {
  db.onversionchange = () => { db.close(); dbPromise = null; };
  return db;
}

function openAt(version) {
  return new Promise((resolve, reject) => {
    const r = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    r.onupgradeneeded = () => ensureStores(r.result);
    r.onsuccess = () => resolve(watch(r.result));
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${DB_NAME} upgrade is blocked by another DOCTrace window. Quit DOCTrace from the tray icon and start it again.`));
  });
}

async function openReady() {
  const db = await openAt();
  if (hasAllStores(db)) return db;
  const next = db.version + 1;
  db.close();
  return openAt(next);
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = openReady().catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const result = await fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  return result;
}

const stepRange = (sessionId) => IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);

// ---------- sessions ----------
export function putSession(session) {
  return tx([SESSIONS], 'readwrite', (t) => req(t.objectStore(SESSIONS).put(session)));
}

export function getSession(sessionId) {
  return tx([SESSIONS], 'readonly', (t) => req(t.objectStore(SESSIONS).get(sessionId)));
}

export async function updateSession(sessionId, patch) {
  return tx([SESSIONS], 'readwrite', async (t) => {
    const store = t.objectStore(SESSIONS);
    const cur = await req(store.get(sessionId));
    if (!cur) throw new Error(`Unknown session ${sessionId}`);
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    await req(store.put(next));
    return next;
  });
}

export async function listSessions() {
  const all = await tx([SESSIONS], 'readonly', (t) => req(t.objectStore(SESSIONS).getAll()));
  return all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

/** Removes the guide's records. Its files on disk are removed by the window (Recycle Bin). */
export function deleteSession(sessionId) {
  return tx([SESSIONS, STEPS], 'readwrite', async (t) => {
    await req(t.objectStore(STEPS).delete(stepRange(sessionId)));
    await req(t.objectStore(SESSIONS).delete(sessionId));
  });
}

// ---------- steps ----------
export function putStep(step) {
  return tx([STEPS], 'readwrite', (t) => req(t.objectStore(STEPS).put(step)));
}

export function getStep(sessionId, stepNumber) {
  return tx([STEPS], 'readonly', (t) => req(t.objectStore(STEPS).get([sessionId, stepNumber])));
}

export function hasStep(sessionId, stepNumber) {
  return tx([STEPS], 'readonly', async (t) => (await req(t.objectStore(STEPS).getKey([sessionId, stepNumber]))) !== undefined);
}

/** Steps in order. withImages=false leaves out the Blob (for the LLM and lists). */
export async function getSteps(sessionId, { withImages = true } = {}) {
  const steps = await tx([STEPS], 'readonly', (t) => req(t.objectStore(STEPS).getAll(stepRange(sessionId))));
  steps.sort((a, b) => a.stepNumber - b.stepNumber);
  if (withImages) return steps;
  return steps.map(({ redactedBlob, ...rest }) => rest);
}

export async function updateStep(sessionId, stepNumber, patch) {
  return tx([STEPS], 'readwrite', async (t) => {
    const store = t.objectStore(STEPS);
    const cur = await req(store.get([sessionId, stepNumber]));
    if (!cur) throw new Error(`Unknown step ${sessionId} #${stepNumber}`);
    const next = { ...cur, ...patch };
    await req(store.put(next));
    return next;
  });
}

// ---------- manifest ----------
/** The exportable manifest. Contains no image data and no raw text. */
export async function buildManifest(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const steps = await getSteps(sessionId, { withImages: false });
  return {
    format: 'doctrace-manual',
    version: 3,
    sessionId: session.sessionId,
    sessionTitle: session.sessionTitle,
    startTime: session.startTime,
    endTime: session.endTime ?? null,
    totalSteps: steps.length,
    failedSteps: steps.filter((s) => s.status !== 'redacted').map((s) => s.stepNumber),
    manualGeneratedBy: session.manualGeneratedBy ?? null,
    intro: session.manualIntro || '',
    guideIntroNarration: session.narrationIntro || '',    // what was said before the first click (scrubbed)
    spokenIntro: session.narrationIntro || '',            // v3.0 name of the same value
    // Voice narration status, so an export shows whether voice was recorded and used.
    voice: {
      recorded: Boolean(session.voice),
      status: session.voiceStatus || 'off',
      error: session.voiceError || null,
      stepsWithNarration: session.voiceSteps ?? 0,
      transcribedBy: session.transcribedBy || null,
    },
    steps: steps.map((s) => ({
      // v3: what was said is bound to the step it was said on, next to the written parts.
      stepNumber: s.stepNumber,
      timestamp: s.timestamp,
      actionType: s.action,
      clickCoords: s.clickCoords,
      targetLabel: s.targetLabel === null ? null : (s.targetLabel || ''),
      redactedImageFileName: s.status === 'redacted' ? s.redactedImageFileName : null,
      spokenNarration: s.narration || '',                 // scrubbed transcript of what was said on this step
      stepTitle: s.manualTitle || '',
      instruction: s.manualDescription || '',
      whereToFindIt: s.manualUiLandmarks || '',
      screenContext: s.manualScreenContext || '',
      expectedOutcome: s.manualExpectedOutcome || '',
      note: s.manualNote || '',
      // v2 names of the same values, kept so older readers keep working
      action: s.action,
      stepDescription: s.manualDescription || '',
      actionInstruction: s.manualDescription || '',
      uiLandmarks: s.manualUiLandmarks || '',
      narration: s.narration || '',
      detectedPii: s.detectedPiiSummary || [],
      descriptionSource: s.descriptionSource || null,
      dwellTimeMs: s.dwellTimeMs ?? null,
      pageTitle: s.pageTitle || '',
      url: s.url || '',
      scrubbedOcrText: s.scrubbedOcrText || '',
      status: s.status,
      // v1 names, kept so older readers of manual_manifest.json keep working
      detectedPiiSummary: s.detectedPiiSummary || [],
      manualTitle: s.manualTitle || '',
      manualDescription: s.manualDescription || '',
    })),
  };
}
