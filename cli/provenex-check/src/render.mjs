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

export function renderTerminal(response) {
  const report = response.signed_report.report;
  const lines = [
    `Provenex Check ${report.command} — ${report.status.toUpperCase()}`,
    `Target: ${report.target}`,
    `Generated: ${report.generated_at}`,
    `Findings: ${report.summary.total} (${report.summary.direct} direct, ${report.summary.correlated} correlated, ${report.summary.tentative} tentative)`,
    `Conclusion: ${report.conclusion}`,
    '',
  ];
  if (report.findings.length === 0) {
    lines.push('No findings were emitted for the evidence and coverage shown below.', '');
  } else {
    lines.push('Findings');
    for (const finding of report.findings) {
      lines.push(
        `- ${finding.title} [${finding.disposition}; ${finding.category}; ${finding.evidence_level}]`,
        `  Consequence: ${finding.consequence}`,
        `  Evidence: ${finding.evidence}`,
        `  Next step: ${finding.next_step}`,
      );
    }
    lines.push('');
  }
  lines.push('Coverage');
  for (const coverage of report.coverage) {
    lines.push(`- ${coverage.category}: ${coverage.status} — ${coverage.detail}`);
  }
  if (report.coverage.length === 0) lines.push('- No coverage records were emitted.');
  lines.push('', 'Limitations');
  if (report.limitations.length === 0) lines.push('- No additional limitations were emitted.');
  else report.limitations.forEach((limitation) => lines.push(`- ${limitation}`));
  lines.push(
    '',
    `Data policy: ${response.retention_policy.policy_id}; application retention raw=0s, derived=0s.`,
    'Integrity: the Ed25519 signature matches the embedded report and response-provided ephemeral run key.',
    'This is self-consistency checking only; it does not establish Provenex issuer identity, server authenticity, or durable attestation.',
  );
  return `${lines.join('\n')}\n`;
}

export function renderHtml(response) {
  const report = response.signed_report.report;
  const findings = report.findings.length
    ? report.findings.map((finding) => `
      <article class="finding">
        <p class="meta">${escapeHtml(finding.id)} · ${escapeHtml(titleCase(finding.disposition))} · ${escapeHtml(titleCase(finding.category))} · ${escapeHtml(titleCase(finding.evidence_level))}</p>
        <h3>${escapeHtml(finding.title)}</h3>
        <dl><dt>Consequence</dt><dd>${escapeHtml(finding.consequence)}</dd><dt>Evidence</dt><dd>${escapeHtml(finding.evidence)}</dd><dt>Next step</dt><dd>${escapeHtml(finding.next_step)}</dd></dl>
      </article>`).join('')
    : '<p class="empty">No findings were emitted for the evidence and coverage shown below.</p>';
  const coverage = report.coverage.length
    ? report.coverage.map((item) => `<li><b>${escapeHtml(titleCase(item.category))}</b><span>${escapeHtml(titleCase(item.status))}</span><p>${escapeHtml(item.detail)}</p></li>`).join('')
    : '<li><p>No coverage records were emitted.</p></li>';
  const limitations = report.limitations.length
    ? report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
    : '<li>No additional limitations were emitted.</li>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Provenex Check — ${escapeHtml(report.target)}</title>
<style>:root{color-scheme:dark;--bg:#091013;--panel:#111a1d;--line:#27383b;--ink:#edf5f4;--muted:#9ab0ad;--accent:#45dfc4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif}main{width:min(960px,calc(100% - 32px));margin:auto;padding:48px 0 72px}header,.section{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:22px;margin-bottom:18px}h1{font-size:clamp(30px,6vw,54px);margin:.2em 0}.meta,.muted{color:var(--muted)}.summary{display:flex;gap:20px;flex-wrap:wrap}.summary b{font-size:26px;display:block}.finding{border-top:1px solid var(--line);padding:20px 0}.finding:first-of-type{border-top:0}h3{margin:.25em 0}dl{display:grid;grid-template-columns:110px 1fr;gap:8px 14px}dt{color:var(--accent);font-weight:700}dd{margin:0}ul{padding-left:20px}.coverage{list-style:none;padding:0}.coverage li{display:grid;grid-template-columns:180px 120px 1fr;gap:12px;border-top:1px solid var(--line);padding:10px 0}.coverage p{margin:0}.integrity{border-left:4px solid var(--accent)}@media(max-width:700px){dl,.coverage li{grid-template-columns:1fr}}</style></head>
<body><main><header><p class="meta">${escapeHtml(report.schema_version)} · ${escapeHtml(report.generated_at)}</p><h1>Provenex Check ${escapeHtml(report.command)}</h1><p>Target: ${escapeHtml(report.target)} · Status: ${escapeHtml(report.status)}</p><div class="summary"><span><b>${report.summary.total}</b>total</span><span><b>${report.summary.direct}</b>direct</span><span><b>${report.summary.correlated}</b>correlated</span><span><b>${report.summary.tentative}</b>tentative</span></div><p>${escapeHtml(report.conclusion)}</p></header>
<section class="section"><h2>Findings</h2>${findings}</section>
<section class="section"><h2>Coverage</h2><ul class="coverage">${coverage}</ul></section>
<section class="section"><h2>Limitations</h2><ul>${limitations}</ul></section>
<section class="section integrity"><h2>Integrity and data policy</h2><p>The Ed25519 signature matches the embedded report and response-provided ephemeral run key. This is self-consistency checking only; it does not establish Provenex issuer identity, server authenticity, or durable attestation.</p><p>Applied policy: ${escapeHtml(response.retention_policy.policy_id)}. Application retention: raw evidence 0 seconds; derived results 0 seconds. Request workspace deletion before response is declared by the service and cannot be independently proven by this CLI.</p><p><a href="${escapeHtml(response.retention_policy.policy_url)}">Read the data policy</a></p></section>
</main></body></html>\n`;
}
