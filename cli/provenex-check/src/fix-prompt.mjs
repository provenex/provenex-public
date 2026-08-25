function listSection(title, items) {
  if (!items.length) return '';
  return `${title}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

/**
 * Build a repository-ready prompt exclusively from validated, sanitized public
 * report fields. Local evidence paths and raw evidence never enter this text.
 */
export function buildCodexFixPrompt(finding, report) {
  const owner = finding.owner_view;
  const remediation = owner.remediation;
  return [
    'Help me review and prepare a scoped fix for this Provenex finding.',
    `Finding\n${owner.headline}`,
    `Why it matters\n${finding.consequence}`,
    `Evidence boundary\n${owner.join}`,
    listSection('What Provenex observed', owner.observed),
    listSection('What Provenex inferred', owner.inferred),
    listSection('What is not established', owner.not_established),
    `Fix goal\n${remediation.goal}`,
    listSection('Changes to evaluate', remediation.changes),
    listSection('Acceptance criteria', remediation.acceptance_criteria),
    [
      'Verification',
      '- Run focused regression tests for the affected behavior.',
      `- Re-run Provenex Check against the same target and approved evidence mode (${report.report_mode}).`,
      '- Compare the new signed report with --verify-against.',
      '- Treat a missing prior key as not verifiable until the signed report proves that exact candidate was evaluated again.',
    ].join('\n'),
    [
      'Working rules',
      '- Inspect the repository and current implementation before editing.',
      '- Do not turn an observation or correlation into a proven cause.',
      '- Keep unknowns unknown until evidence establishes them.',
      '- Do not access an external provider, change production state, or post anything without explicit authorization.',
      '- Keep the patch scoped, add regression coverage, and report exactly what was and was not verified.',
    ].join('\n'),
    'Return a concise plan, likely files to inspect, the proposed patch, tests to run, and remaining evidence gaps.',
  ].filter(Boolean).join('\n\n');
}
