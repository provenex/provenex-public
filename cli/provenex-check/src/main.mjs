import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { parseArgs, usage, VERSION } from './args.mjs';
import {
  collectDataset,
  DEFAULT_EXCLUDED_DIRECTORIES,
  discoverAiHistory,
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

function renderPreflight({ origin, command, target, dataset, outputs, aiHistoryRequested }) {
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
      : 'AI history: not requested (add --discover-ai-history for telemetry correlation)',
    `Total upload content: ${formatBytes(dataset.totalBytes)} bytes`,
    `Categories: ${dataset.categories.length ? dataset.categories.join(', ') : '(none)'}`,
    `High-sensitivity categories: ${sensitive.length ? sensitive.join(', ') : '(none)'}`,
    `Default exclusions: ${DEFAULT_EXCLUDED_DIRECTORIES.join(', ')}; all symlinks; non-selected file types`,
    'Always-on local-auth exclusions: Provenex, Codex, and Claude credential',
    'stores are excluded before selection; their local paths are neither',
    'displayed nor uploaded.',
    'Always-on AI-history exclusions: known Claude and Codex history roots are',
    'pruned from ordinary source traversal; use --discover-ai-history or an',
    'explicit artifact input to consent to supported session evidence.',
    'Always-on web-export exclusion: conversations.json is never swept as',
    'ordinary source/configuration; select it explicitly with --session-input.',
    dataset.userExcludePatterns.length
      ? `User exclusions (local only): ${boundedList(dataset.userExcludePatterns)}; ${dataset.userExcludedEntries} matched entries/directories pruned`
      : 'User exclusions: (none; add repeatable --exclude PATTERN)',
    dataset.highSensitivitySourcePaths.length
      ? `High-sensitivity source paths selected: ${boundedList(dataset.highSensitivitySourcePaths)}`
      : 'High-sensitivity source paths selected: (none)',
    dataset.explicitArtifactInputs.length
      ? `Explicit artifact inputs selected (local paths are not uploaded as metadata): ${boundedList(dataset.explicitArtifactInputs.map((input) => `${input.kind}: ${input.localPath} (${input.bytes} bytes)`))}`
      : 'Explicit artifact inputs selected: (none)',
    `JSON output: ${outputs.json ? quoteLocal(outputs.json) : '(not requested)'}`,
    `HTML output: ${outputs.html ? quoteLocal(outputs.html) : '(not requested)'}`,
    '',
    `Required data policy: ${CHECK_DATA_POLICY.policy_id}`,
    `Application retention: raw evidence ${CHECK_DATA_POLICY.raw_evidence_retention_seconds}s; derived results ${CHECK_DATA_POLICY.derived_results_retention_seconds}s`,
    `Server workspace: ${CHECK_DATA_POLICY.workspace_lifecycle}; deletion before response required`,
    `Policy document: ${CHECK_DATA_POLICY.policy_url}`,
    'The CLI validates the response policy declaration; it cannot independently',
    'prove server-side deletion or create durable issuer authenticity.',
    '',
    ...(localDevelopment
      ? [
        'LOCAL DEVELOPMENT WARNING: this endpoint is not Provenex\'s central',
        'service. Do not submit real sensitive evidence or a production API key.',
        'Only PROVENEX_CHECK_DEV_API_KEY is eligible for this endpoint; production',
        'credentials and config are ignored. The endpoint must still emulate the',
        'exact v1 applied policy above; a missing or different policy causes the',
        'CLI to reject the entire response.',
      ]
      : [
        'This Check uploads the approved evidence to Provenex\'s central multi-tenant',
        'service. The service must return this exact applied policy; a missing or',
        'different policy causes the CLI to reject the entire response.',
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

function buildRequest(command, target, dataset) {
  return {
    schema_version: 'provenex-check-request.v1',
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

  const origin = validateApiOrigin(options.apiUrl);
  const root = await resolveScanRoot(options.targetPath);
  const target = targetLabelForRoot(root);
  const preparedOutputs = await prepareOutputs(options.outputs, root, options.force);
  const discovered = options.discoverAiHistory ? await discoverAiHistory(root) : [];
  const localHome = localHomePath();
  const dataset = await collectDataset({
    root,
    artifactInputs: [...options.artifacts, ...discovered],
    excludes: options.excludes,
    protectedFiles: [
      apiKeyConfigPath(),
      path.join(localHome, '.codex', 'auth.json'),
      path.join(localHome, '.claude', '.credentials.json'),
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
  }));

  if (options.dryRun) {
    stdout.write('Dry run complete: nothing was uploaded and no API key was read.\n');
    return 0;
  }
  if (!options.yes && !(await confirmUpload(origin))) {
    throw new UsageError('upload cancelled; nothing was sent');
  }

  const request = buildRequest(options.command, target, dataset);
  const serializedRequest = JSON.stringify(request);
  const requestBytes = Buffer.byteLength(serializedRequest);
  if (requestBytes > SERVER_LIMITS.maxRequestBytes) {
    throw new Error(
      `serialized API request is ${requestBytes} bytes; server body limit is ${SERVER_LIMITS.maxRequestBytes}`,
    );
  }
  const apiKey = await loadApiKey(origin);
  assertActiveBearerAbsent(dataset, apiKey);
  const response = await submitRun({
    origin,
    apiKey,
    serializedRequest,
    expected: { command: options.command, target },
  });
  const terminal = renderTerminal(response);
  const html = preparedOutputs.html ? renderHtml(response) : null;
  const written = await writeReports(preparedOutputs, response, html, options.force);
  stdout.write(terminal);
  for (const destination of written) stdout.write(`Wrote ${quoteLocal(destination)}\n`);
  return response.exit_code;
}

export { assertActiveBearerAbsent, buildRequest, renderPreflight };
