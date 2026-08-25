import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { parseArgs, usage, VERSION } from './args.mjs';
import {
  collectDataset,
  DEFAULT_EXCLUDED_DIRECTORIES,
  inspectAiHistory,
  localHomePath,
  resolveScanRoot,
  SENSITIVE_CATEGORIES,
  targetLabelForRoot,
} from './collector.mjs';
import {
  apiKeyConfigPath,
  isLoopbackApiOrigin,
  loadApiKey,
  submitRun,
  validateApiOrigin,
} from './client.mjs';
import { prepareOutputs, writeReports } from './output.mjs';
import { UsageError } from './errors.mjs';
import { SERVER_LIMITS } from './limits.mjs';
import { CHECK_DATA_POLICY } from './policy.mjs';
import { renderHtml, renderTerminal } from './render.mjs';
import { renderCapabilities, renderPlan } from './plan.mjs';
import { applyTelemetryFormats, offerEvidence, shouldOfferEvidence } from './prompt.mjs';
import {
  assertPriorResponseOutsideRoot,
  comparePriorResponse,
  deriveProjectScope,
  loadPriorResponse,
} from './verification.mjs';

const PREFLIGHT_LIST_LIMIT = 20;

function formatBytes(bytes) {
  return new Intl.NumberFormat('en-US').format(bytes);
}

function quoteLocal(value) {
  const terminalSafe = [...value].map((character) => (
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character)
      ? `\\u{${character.codePointAt(0).toString(16)}}`
      : character
  )).join('');
  return JSON.stringify(terminalSafe);
}

function boundedList(values) {
  const visible = values.slice(0, PREFLIGHT_LIST_LIMIT).map(quoteLocal);
  const omitted = values.length - visible.length;
  return `${visible.join(', ')}${omitted > 0 ? `, … plus ${omitted} more` : ''}`;
}

function renderPreflight({ origin, command, target, dataset, outputs, aiHistoryRequested, listFiles }) {
  const sensitive = dataset.categories.filter((category) => SENSITIVE_CATEGORIES.has(category));
  const localDevelopment = isLoopbackApiOrigin(origin);
  const lines = [
    'Provenex Check upload preflight',
    `API origin: ${origin}`,
    localDevelopment
      ? 'Endpoint class: non-production loopback development endpoint'
      : 'Endpoint class: Provenex central multi-tenant service',
    `Command: ${command}`,
    `Target label: ${quoteLocal(target)}`,
    `Source files: ${dataset.sourceFiles.length} (${formatBytes(dataset.sourceBytes)} bytes)`,
    `Artifacts: ${dataset.artifacts.length} (${formatBytes(dataset.artifactBytes)} bytes)`,
    aiHistoryRequested
      ? `AI history: requested; ${dataset.discoveredSessionCount} exact-cwd matches (${formatBytes(dataset.discoveredSessionBytes)} bytes)`
      : 'AI history: not requested (add --discover-ai-history for an independent session review)',
    `Total upload content: ${formatBytes(dataset.totalBytes)} bytes`,
    `Categories: ${dataset.categories.length ? dataset.categories.join(', ') : '(none)'}`,
    `High-sensitivity categories: ${sensitive.length ? sensitive.join(', ') : '(none)'}`,
    `Default exclusions: ${DEFAULT_EXCLUDED_DIRECTORIES.join(', ')}; all symlinks; non-selected file types`,
    'Always-on local-auth exclusions: Provenex, Codex, and Claude credentials and history stores.',
    'Project binding: the absolute root is not sent; the credential is still sent separately as the request Authorization bearer.',
    dataset.userExcludePatterns.length
      ? `User exclusions (local only): ${boundedList(dataset.userExcludePatterns)}; ${dataset.userExcludedEntries} matched entries/directories pruned`
      : 'User exclusions: (none; add repeatable --exclude PATTERN)',
    dataset.highSensitivitySourcePaths.length
      ? `High-sensitivity source paths selected: ${boundedList(dataset.highSensitivitySourcePaths)}`
      : 'High-sensitivity source paths selected: (none)',
    ...(listFiles
      ? [
        'Selected source paths:',
        ...dataset.sourceFiles.map((file) => `  ${quoteLocal(file.relative_path)}`),
      ]
      : []),
    dataset.explicitArtifactInputs.length
      ? `Explicit artifact inputs selected (local paths are not uploaded as metadata): ${boundedList(dataset.explicitArtifactInputs.map((input) => `${input.kind}: ${input.localPath} (${input.bytes} bytes)`))}`
      : 'Explicit artifact inputs selected: (none)',
    ...(outputs.json ? [`JSON output: ${quoteLocal(outputs.json)}`] : []),
    ...(outputs.html ? [`HTML output: ${quoteLocal(outputs.html)}`] : []),
    `Policy: ${CHECK_DATA_POLICY.policy_id}; raw ${CHECK_DATA_POLICY.raw_evidence_retention_seconds}s; derived ${CHECK_DATA_POLICY.derived_results_retention_seconds}s; ${CHECK_DATA_POLICY.policy_url}`,
    ...(localDevelopment
      ? [
        'LOCAL DEVELOPMENT: use only PROVENEX_CHECK_DEV_API_KEY and synthetic evidence.',
      ]
      : [
        'Approved evidence goes to Provenex\'s central multi-tenant service.',
      ]),
  ];
  return `${lines.join('\n')}\n`;
}

export async function confirmUpload(origin, { input = stdin, output = stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError('upload requires interactive approval or explicit --yes');
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(`Upload this bounded dataset to ${origin}? Type yes to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

function buildRequest(command, target, dataset, projectScope) {
  return {
    schema_version: 'provenex-check-request.v1',
    requested_report_schema: 'provenex-check-public-report.v2',
    project_scope: projectScope,
    command,
    target,
    consent: {
      approved: true,
      categories: dataset.categories,
      policy_id: CHECK_DATA_POLICY.policy_id,
    },
    source_files: dataset.sourceFiles,
    artifacts: dataset.artifacts,
  };
}

function assertActiveBearerAbsent(dataset, apiKey) {
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  const representations = escaped === apiKey ? [apiKey] : [apiKey, escaped];
  const selectedContent = [
    ...dataset.sourceFiles.map((file) => file.content),
    ...dataset.artifacts.map((artifact) => artifact.content),
  ];
  if (selectedContent.some((content) => representations.some((value) => content.includes(value)))) {
    throw new Error(
      'selected evidence contains the active API credential; redact it before uploading',
    );
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.command === 'capabilities') {
    stdout.write(renderCapabilities());
    return 0;
  }
  if (options.command === 'plan') {
    stdout.write(await renderPlan(options.targetPath));
    return 0;
  }

  const origin = validateApiOrigin(options.apiUrl);
  const root = await resolveScanRoot(options.targetPath);
  const target = targetLabelForRoot(root);
  let priorResponse = null;
  if (options.verifyAgainst) {
    await assertPriorResponseOutsideRoot(options.verifyAgainst, root);
    priorResponse = await loadPriorResponse(options.verifyAgainst, { command: 'scan', target });
  }
  const preparedOutputs = await prepareOutputs(options.outputs, root, options.force);
  let guidedAiHistory = null;
  if (shouldOfferEvidence(options)) {
    guidedAiHistory = await inspectAiHistory(root);
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      await offerEvidence(options, {
        question: (query) => prompt.question(query),
        writeln: (line) => stdout.write(`${line}\n`),
        aiHistoryDiscovery: guidedAiHistory,
      });
    } finally {
      prompt.close();
    }
  }
  await applyTelemetryFormats(options);
  let discovered = [];
  if (options.discoverAiHistory) {
    const selection = guidedAiHistory || await inspectAiHistory(root);
    if (selection.status === 'unavailable') {
      throw new Error(
        'AI history discovery unavailable: the bounded metadata check could not finish safely',
      );
    }
    discovered = selection.matches;
  }
  const localHome = localHomePath();
  const dataset = await collectDataset({
    root,
    artifactInputs: [...options.artifacts, ...discovered],
    excludes: options.excludes,
    protectedFiles: [
      apiKeyConfigPath(),
      path.join(localHome, '.codex', 'auth.json'),
      path.join(localHome, '.claude', '.credentials.json'),
      ...(options.verifyAgainst ? [options.verifyAgainst] : []),
    ],
    protectedDirectories: [
      path.join(localHome, '.claude', 'projects'),
      path.join(localHome, '.codex', 'sessions'),
    ],
    limits: options.limits,
  });
  stdout.write(renderPreflight({
    origin,
    command: options.command,
    target,
    dataset,
    outputs: preparedOutputs,
    aiHistoryRequested: options.discoverAiHistory,
    listFiles: options.listFiles,
  }));

  if (options.dryRun) {
    stdout.write('Dry run complete: nothing was uploaded and no API key was read.\n');
    return 0;
  }
  if (!options.yes && !(await confirmUpload(origin))) {
    throw new UsageError('upload cancelled; nothing was sent');
  }

  const apiKey = await loadApiKey(origin);
  const projectScope = deriveProjectScope(apiKey, root);
  const request = buildRequest(options.command, target, dataset, projectScope);
  const serializedRequest = JSON.stringify(request);
  const requestBytes = Buffer.byteLength(serializedRequest);
  if (requestBytes > SERVER_LIMITS.maxRequestBytes) {
    throw new Error(
      `serialized API request is ${requestBytes} bytes; server body limit is ${SERVER_LIMITS.maxRequestBytes}`,
    );
  }
  assertActiveBearerAbsent(dataset, apiKey);
  const response = await submitRun({
    origin,
    apiKey,
    serializedRequest,
    expected: {
      command: options.command,
      target,
      projectScope,
    },
    limits: options.requestTimeoutMs === null ? {} : {
      uploadAndHeadersTotalMs: options.requestTimeoutMs,
    },
  });
  const verification = priorResponse ? comparePriorResponse(priorResponse, response) : null;
  const terminal = renderTerminal(response, { verification });
  const html = preparedOutputs.html ? renderHtml(response, { verification }) : null;
  const written = await writeReports(preparedOutputs, response, html, options.force);
  stdout.write(terminal);
  for (const destination of written) stdout.write(`Wrote ${quoteLocal(destination)}\n`);
  return response.exit_code;
}

export { assertActiveBearerAbsent, buildRequest, renderPreflight };
