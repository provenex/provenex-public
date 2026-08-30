import { buildCodingAgentFixPrompt } from './fix-prompt.mjs';

const CODING_AGENT_PROMPT_LABEL = 'Paste-ready fix prompt for Cursor, Claude, Codex, or your coding agent';

const NEXT_EVIDENCE_PRIORITY = Object.freeze([
  'ai_sessions',
  'agent_traces',
  'parent_links',
  'tool_payloads',
  'vendor_audit',
  'runtime_logs',
  'identity',
  'classification',
  'dependency_audit',
  'agent_config',
  'payments',
  'cost_export',
]);

function titleCase(value) {
  return value.split('_').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function strongestNextEvidence(report) {
  const actionable = report.next_evidence.filter((item) => item.status !== 'present');
  return [...actionable].sort((left, right) => {
    const leftRank = NEXT_EVIDENCE_PRIORITY.indexOf(left.surface);
    const rightRank = NEXT_EVIDENCE_PRIORITY.indexOf(right.surface);
    return (leftRank === -1 ? NEXT_EVIDENCE_PRIORITY.length : leftRank)
      - (rightRank === -1 ? NEXT_EVIDENCE_PRIORITY.length : rightRank);
  })[0] || null;
}

function ownerVisibleFindings(report) {
  const evidenceRank = { direct: 0, correlated: 1, tentative: 2 };
  return report.findings.map((finding, index) => ({ finding, index })).sort((left, right) => {
    const rank = ({ finding, index }) => {
      const authored = finding.owner_view.verification_key !== null;
      const composition = finding.category === 'data_governance' || finding.category === 'cross_signal';
      const authoredRank = authored && composition ? 0 : authored ? 1 : 2;
      return [authoredRank, evidenceRank[finding.evidence_level], index];
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    return leftRank[0] - rightRank[0]
      || leftRank[1] - rightRank[1]
      || leftRank[2] - rightRank[2];
  }).map(({ finding }) => finding);
}

function incompleteCoverageGap(report) {
  if (report.status !== 'incomplete') return null;
  return report.coverage.find((item) => item.status !== 'evaluated')?.detail
    || report.limitations[0]
    || 'The analysis did not complete within its declared bounds.';
}

function pushLabeledList(lines, label, values) {
  if (!values.length) return;
  lines.push(`  ${label}:`);
  values.forEach((value) => lines.push(`    - ${value}`));
}

function renderSourcePreviewTerminal(response, verification) {
  const report = response.signed_report.report;
  const clues = ownerVisibleFindings(report).slice(0, 3);
  const next = strongestNextEvidence(report);
  const lines = [
    'Evidence preview: no joined business risk was evaluated',
    `Target: ${report.target}`,
    `Generated: ${report.generated_at}`,
    `Status: ${report.status.toUpperCase()}`,
    '',
    clues.length
      ? `Evidence clues (showing ${clues.length} of ${report.findings.length})`
      : 'No evidence clues were emitted.',
  ];
  for (const finding of clues) {
    lines.push(
      `- ${finding.owner_view.headline}`,
      `  Why it may matter: ${finding.consequence}`,
    );
    pushLabeledList(lines, 'Observed', finding.owner_view.observed);
    pushLabeledList(lines, 'Inferred', finding.owner_view.inferred);
    pushLabeledList(lines, 'Not established', finding.owner_view.not_established);
  }
  const incomplete = incompleteCoverageGap(report);
  if (incomplete) lines.push('', `One coverage gap in this incomplete run: ${incomplete}`);
  if (next) {
    lines.push(
      '',
      'One input that would most improve the answer',
      `- ${titleCase(next.surface)}: ${next.why}`,
      `  How: ${next.how}`,
    );
  }
  lines.push(...renderVerificationTerminal(verification));
  const promptFinding = clues.find((finding) => finding.owner_view.verification_key !== null);
  if (promptFinding) {
    lines.push(
      '',
      CODING_AGENT_PROMPT_LABEL,
      '-----',
      buildCodingAgentFixPrompt(promptFinding, report),
      '-----',
    );
  }
  lines.push('', 'Use --json on a run to save the complete validated response.');
  return `${lines.join('\n')}\n`;
}

function renderVerificationTerminal(verification) {
  if (!verification) return [];
  const lines = ['', 'Verification against the prior signed report'];
  if (!verification.findings.length) {
    lines.push('- The prior report had no findings to compare.');
  } else {
    for (const item of verification.findings) {
      lines.push(
        `- ${item.headline}: ${item.outcome}`,
        `  ${item.reason}`,
      );
    }
  }
  lines.push('A missing prior key remains not verifiable until the signed report proves that exact candidate was evaluated again.');
  return lines;
}

export function renderTerminal(response, { verification = null } = {}) {
  const report = response.signed_report.report;
  if (report.report_mode === 'source_preview') {
    return renderSourcePreviewTerminal(response, verification);
  }

  const lines = [
    `Provenex Check: ${report.status.toUpperCase()}`,
    `Target: ${report.target}`,
    `Generated: ${report.generated_at}`,
    '',
    'What could affect your business',
  ];
  const visibleFindings = ownerVisibleFindings(report).slice(0, 5);
  const promptFinding = visibleFindings.find(
    (finding) => finding.owner_view.verification_key !== null,
  );
  if (!report.findings.length) {
    lines.push('No findings were emitted for the joined evidence and coverage shown below.');
  } else {
    for (const finding of visibleFindings) {
      const owner = finding.owner_view;
      lines.push(
        `- ${owner.headline}`,
        `  Why it matters: ${finding.consequence}`,
        `  Evidence joined: ${owner.join}`,
      );
      pushLabeledList(lines, 'Observed', owner.observed);
      pushLabeledList(lines, 'Inferred', owner.inferred);
      pushLabeledList(lines, 'Not established', owner.not_established);
      lines.push(`  Fix goal: ${owner.remediation.goal}`);
      owner.remediation.changes.forEach((change) => lines.push(`    - ${change}`));
      lines.push(
        `  Details: ${titleCase(owner.impact_lane)} · ${titleCase(finding.evidence_level)} evidence · ${titleCase(finding.disposition)}`,
      );
    }
    if (visibleFindings.length < report.findings.length) {
      lines.push(`Showing ${visibleFindings.length} of ${report.findings.length} findings. Use --json to save the complete validated response.`);
    }
  }

  lines.push(...renderVerificationTerminal(verification));

  if (promptFinding) {
    lines.push(
      '',
      CODING_AGENT_PROMPT_LABEL,
      '-----',
      buildCodingAgentFixPrompt(promptFinding, report),
      '-----',
    );
  }

  lines.push('', 'Coverage');
  for (const coverage of report.coverage) {
    lines.push(`- ${titleCase(coverage.category)}: ${titleCase(coverage.status)}. ${coverage.detail}`);
  }
  if (!report.coverage.length) lines.push('- No coverage records were emitted.');
  const next = strongestNextEvidence(report);
  if (next) {
    lines.push(
      '',
      'Next evidence',
      `- ${titleCase(next.surface)}: ${next.why}`,
      `  How: ${next.how}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function htmlFactList(label, values) {
  if (!values.length) return '';
  return `<div class="facts"><h4>${escapeHtml(label)}</h4><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul></div>`;
}

function htmlShell(report, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Provenex Check: ${escapeHtml(report.target)}</title>
<style>:root{color-scheme:dark;--bg:#161826;--panel:#232532;--panel2:#292b31;--line:#3f424d;--ink:#e9e9ed;--muted:#9397ab;--accent:#9184d9;--good:#5fd39a;--warn:#f0a93b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.58 Inter,system-ui,sans-serif}main{width:min(920px,calc(100% - 32px));margin:auto;padding:44px 0 72px}header,.section{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:24px;margin-bottom:18px}h1{font-size:clamp(28px,5vw,48px);line-height:1.08;margin:.2em 0 .35em}h2{font-size:22px;margin:.1em 0 .8em}h3{font-size:20px;line-height:1.3;margin:.2em 0 .5em}h4{margin:0;color:var(--accent);font-size:13px;text-transform:uppercase;letter-spacing:.04em}.meta,.muted{color:var(--muted)}.finding{border-top:1px solid var(--line);padding:24px 0}.finding:first-of-type{border-top:0}.impact{font-size:17px}.join{background:var(--panel2);border-radius:10px;padding:12px 14px}.facts{display:grid;grid-template-columns:150px 1fr;gap:12px;margin:14px 0}.facts ul{margin:0;padding-left:20px}.fix{border-left:3px solid var(--accent);padding-left:14px}.technical{color:var(--muted);font-size:13px}.coverage{list-style:none;padding:0}.coverage li{display:grid;grid-template-columns:180px 140px 1fr;gap:12px;border-top:1px solid var(--line);padding:12px 0}.coverage p{margin:0}.prompt{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:16px;color:var(--ink);font:13px/1.55 ui-monospace,monospace}.preview{border-color:#5d5294}.next{border-left:4px solid var(--warn)}.outcome{border-top:1px solid var(--line);padding:12px 0}.outcome code{color:var(--good)}a{color:#d2cefd}@media(max-width:700px){.facts,.coverage li{grid-template-columns:1fr}}</style></head>
<body><main>${body}</main></body></html>\n`;
}

function renderSourcePreviewHtml(response, verification) {
  const report = response.signed_report.report;
  const visibleClues = ownerVisibleFindings(report).slice(0, 3);
  const clues = visibleClues.map((finding) => `<article class="finding"><h3>${escapeHtml(finding.owner_view.headline)}</h3><p class="impact">${escapeHtml(finding.consequence)}</p>${htmlFactList('Observed', finding.owner_view.observed)}${htmlFactList('Inferred', finding.owner_view.inferred)}${htmlFactList('Not established', finding.owner_view.not_established)}</article>`).join('');
  const next = strongestNextEvidence(report);
  const nextHtml = next
    ? `<section class="section next"><h2>One input that would most improve the answer</h2><h3>${escapeHtml(titleCase(next.surface))}</h3><p>${escapeHtml(next.why)}</p><p>${escapeHtml(next.how)}</p></section>`
    : '';
  const incomplete = incompleteCoverageGap(report);
  const incompleteHtml = incomplete
    ? `<section class="section next"><h2>One coverage gap in this incomplete run</h2><p>${escapeHtml(incomplete)}</p></section>`
    : '';
  const promptFinding = visibleClues.find((finding) => finding.owner_view.verification_key !== null);
  const promptHtml = promptFinding
    ? `<section class="section"><details><summary>${CODING_AGENT_PROMPT_LABEL}</summary><pre class="prompt">${escapeHtml(buildCodingAgentFixPrompt(promptFinding, report))}</pre></details></section>`
    : '';
  return htmlShell(report, `<header class="preview"><p class="meta">${escapeHtml(report.generated_at)} · ${escapeHtml(report.target)} · ${escapeHtml(report.status)}</p><h1>Evidence preview</h1><p class="impact">No joined business risk was evaluated.</p><p class="muted">Shows at most three evidence clues. Use --json on a run to save the complete validated response.</p></header><section class="section"><h2>Evidence clues${report.findings.length ? ` · showing ${Math.min(3, report.findings.length)} of ${report.findings.length}` : ''}</h2>${clues || '<p>No evidence clues were emitted.</p>'}</section>${incompleteHtml}${nextHtml}${verificationHtml(verification)}${promptHtml}`);
}

function verificationHtml(verification) {
  if (!verification) return '';
  const outcomes = verification.findings.length
    ? verification.findings.map((item) => `<div class="outcome"><h3>${escapeHtml(item.headline)}</h3><p><code>${escapeHtml(item.outcome)}</code></p><p>${escapeHtml(item.reason)}</p></div>`).join('')
    : '<p>The prior report had no findings to compare.</p>';
  return `<section class="section"><h2>Verification against the prior signed report</h2>${outcomes}<p class="muted">A missing prior key remains not verifiable until the signed report proves that exact candidate was evaluated again.</p></section>`;
}

export function renderHtml(response, { verification = null } = {}) {
  const report = response.signed_report.report;
  if (report.report_mode === 'source_preview') return renderSourcePreviewHtml(response, verification);

  const visibleFindings = ownerVisibleFindings(report).slice(0, 5);
  const promptFinding = visibleFindings.find(
    (finding) => finding.owner_view.verification_key !== null,
  );
  const findings = report.findings.length
    ? visibleFindings.map((finding) => {
      const owner = finding.owner_view;
      const prompt = finding === promptFinding
        ? `<details><summary>${CODING_AGENT_PROMPT_LABEL}</summary><pre class="prompt">${escapeHtml(buildCodingAgentFixPrompt(finding, report))}</pre></details>`
        : '';
      const changes = owner.remediation.changes.length
        ? `<ul>${owner.remediation.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join('')}</ul>`
        : '';
      return `<article class="finding"><h3>${escapeHtml(owner.headline)}</h3><p class="impact">${escapeHtml(finding.consequence)}</p><p class="join"><b>Evidence joined:</b> ${escapeHtml(owner.join)}</p>${htmlFactList('Observed', owner.observed)}${htmlFactList('Inferred', owner.inferred)}${htmlFactList('Not established', owner.not_established)}<div class="fix"><h4>Fix goal</h4><p>${escapeHtml(owner.remediation.goal)}</p>${changes}</div>${prompt}<details class="technical"><summary>Technical details</summary><p>${escapeHtml(titleCase(owner.impact_lane))} · ${escapeHtml(titleCase(finding.evidence_level))} evidence · ${escapeHtml(titleCase(finding.disposition))}</p></details></article>`;
    }).join('') + (visibleFindings.length < report.findings.length
      ? `<p class="muted">Showing ${visibleFindings.length} of ${report.findings.length} findings. Use --json on a run to save the complete validated response.</p>`
      : '')
    : '<p>No findings were emitted for the joined evidence and coverage shown below.</p>';
  const coverage = report.coverage.length
    ? report.coverage.map((item) => `<li><b>${escapeHtml(titleCase(item.category))}</b><span>${escapeHtml(titleCase(item.status))}</span><p>${escapeHtml(item.detail)}</p></li>`).join('')
    : '<li><p>No coverage records were emitted.</p></li>';
  const next = strongestNextEvidence(report);
  const nextHtml = next
    ? `<section class="section next"><h2>Next evidence</h2><h3>${escapeHtml(titleCase(next.surface))}</h3><p>${escapeHtml(next.why)}</p><p>${escapeHtml(next.how)}</p></section>`
    : '';
  return htmlShell(report, `<header><p class="meta">${escapeHtml(report.generated_at)} · ${escapeHtml(report.target)} · ${escapeHtml(report.status)}</p><h1>What could affect your business</h1><p>${escapeHtml(report.conclusion)}</p></header><section class="section"><h2>Findings</h2>${findings}</section>${verificationHtml(verification)}<section class="section"><h2>Coverage</h2><ul class="coverage">${coverage}</ul></section>${nextHtml}`);
}

export { escapeHtml, ownerVisibleFindings, strongestNextEvidence };
