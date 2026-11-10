// manual.md for a guide, built from its manifest (sessionStore.buildManifest).
// Images are referenced as steps/step_N.png; the guides window rewrites that to
// step_N.png because the files sit next to manual.md in the recording folder.

export function manualMarkdown(manifest) {
  const lines = [`# ${manifest.sessionTitle || 'Recorded tutorial'}`, ''];
  if (manifest.startTime) lines.push(`Recorded ${new Date(manifest.startTime).toLocaleString()}`, '');
  if (manifest.intro) lines.push(manifest.intro, '');
  const spokenIntro = manifest.guideIntroNarration ?? manifest.spokenIntro;
  if (spokenIntro) lines.push(`> 🎙 *"${spokenIntro}"*`, '');
  for (const s of manifest.steps) {
    const stepTitle = s.stepTitle || s.manualTitle;
    lines.push(`## Step ${s.stepNumber}${stepTitle ? `: ${stepTitle}` : ''}`, '');
    const said = s.spokenNarration ?? s.narration;
    if (said) lines.push(`> 🎙 *"${said}"*`, '');
    lines.push(s.instruction || s.stepDescription || s.manualDescription || `(${s.action}) ${s.targetLabel || ''}`.trim(), '');
    const where = s.whereToFindIt ?? s.uiLandmarks;
    if (where) lines.push(`**Where:** ${where}`, '');
    if (s.redactedImageFileName) lines.push(`![Step ${s.stepNumber}](steps/${s.redactedImageFileName})`, '');
    else lines.push('_Screenshot not available: this step could not be protected, so it was not saved._', '');
    if (s.screenContext) lines.push(`**On this screen:** ${s.screenContext}`, '');
    if (s.expectedOutcome) lines.push(`**Expected result:** ${s.expectedOutcome}`, '');
    if (s.note) lines.push(`> **Note:** ${s.note}`, '');
  }
  return lines.join('\n');
}
