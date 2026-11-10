// Screenshots for the vision model on this computer, and the shared error type
// of the AI clients.
//
// Only frames that pass the privacy gate (status "redacted", black boxes already
// burned in) are used. Each one is shrunk and re-encoded as JPEG, then base64
// for the OpenAI-compatible request body. Raw screenshots never reach this file.

import { assertUploadable } from '../privacy/guard.js';

// A model on a CPU reads the image itself: a 1600 px screenshot is ~1,800 image
// tokens for Qwen2.5-VL, 1024 px about 780, so each step is roughly twice as
// fast. The screen text also goes in as (scrubbed) text, so little detail is lost.
export const IMAGE_SIDE = 1024;

export class LlmRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LlmRequestError';
    this.code = code;
  }
}

class ImagePrepError extends Error {}

const CHUNK = 0x8000;
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function resizeRedactedImage(blob, maxSide = IMAGE_SIDE) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    if (!longestSide) throw new Error('Empty image');
    const scale = Math.min(1, maxSide / longestSide);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    if (!jpeg.size || jpeg.type !== 'image/jpeg') throw new Error('JPEG encoding failed');
    return jpeg;
  } catch {
    throw new ImagePrepError('Could not prepare a protected screenshot.');
  } finally {
    bitmap?.close();
  }
}

/** Read, check and encode the redacted screenshot of each step. */
export async function prepareImages(steps, getStep, { maxSide = IMAGE_SIDE } = {}) {
  const images = [];
  const skippedStepNumbers = [];

  for (const step of steps) {
    const frame = await getStep(step.sessionId, step.stepNumber);
    try {
      assertUploadable(frame);
    } catch {
      skippedStepNumbers.push(step.stepNumber);
      continue;
    }

    try {
      const jpeg = await resizeRedactedImage(frame.redactedBlob, maxSide);
      images.push({ stepNumber: step.stepNumber, base64: await blobToBase64(jpeg) });
    } catch (error) {
      if (!(error instanceof ImagePrepError)) throw error;
      skippedStepNumbers.push(step.stepNumber);
    }
  }

  return { images, skippedStepNumbers };
}

/**
 * Describe the groups one after another (a model on this computer works on one
 * request at a time; parallel requests would only queue inside it and time out).
 * onGroup(group, { results, skippedStepNumbers, error }) saves each group's text.
 */
export async function runGroups(groups, processGroup, onGroup) {
  for (const group of groups) {
    let outcome;
    try {
      outcome = { ...(await processGroup(group)), error: null };
    } catch (error) {
      outcome = { results: new Map(), skippedStepNumbers: [], error };
    }
    await onGroup(group, outcome);
  }
}
