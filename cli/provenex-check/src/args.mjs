import path from 'node:path';
import { UsageError } from './errors.mjs';
import { EXCLUDE_LIMITS, SERVER_LIMITS } from './limits.mjs';

export const VERSION = '0.1.0-alpha.3';

export const REQUEST_TIMEOUT = Object.freeze({
  defaultSeconds: 30 * 60,
  maxSeconds: 2 * 60 * 60,
});

const ARTIFACT_FLAGS = new Map([
  ['--session-input', 'session'],
  ['--fly-log', 'fly_log'],
  ['--cloudwatch-log', 'cloudwatch_log'],
  ['--aws-input', 'aws_cost'],
  ['--dependency-audit', 'dependency_audit'],
  ['--telemetry', 'telemetry'],
]);

const VALUE_FLAGS = new Set([
  '--api-url',
  '--json',
  '--html',
  '--verify-against',
  '--timeout',
  '--max-files',
  '--max-file-bytes',
  '--max-artifact-bytes',
  '--max-total-bytes',
  '--exclude',
  '--telemetry-format',
  ...ARTIFACT_FLAGS.keys(),
]);

export function usage() {
  return `Usage:
  provenex-check demo
  provenex-check plan [path]
  provenex-check capabilities
  provenex-check scan [path] [options]
  provenex-check audit [path] [options]

demo renders one built-in Brightcart result without reading files or calling a service.
plan inventories local evidence surfaces without uploading.
capabilities lists what each consented surface unlocks.
scan and audit collect a bounded, consented dataset and send it to the hosted
Provenex API. No analysis engine is bundled or downloaded.

Options:
  --api-url URL              Loopback development override only; production is
                             pinned to https://api.provenex.ai
  --session-input PATH       Add session JSONL or conversations.json (repeatable)
  --telemetry PATH           Add runtime traces (OTLP JSON by default; repeatable)
  --telemetry-format FORMAT  Format for --telemetry (default otel; also langfuse,
                             langsmith, langchain, chatgpt, okta, bedrock, m365,
                             anthropic, gws, github, salesforce, slack, mcp,
                             shopify, data-activity). github is org/enterprise
                             audit-log JSON, not Actions job logs. Native
                             Langfuse JSON and LangSmith REST runs ingest as otel.
  --fly-log PATH             Add a Fly log export (repeatable)
  --cloudwatch-log PATH      Add a CloudWatch log export (repeatable)
  --aws-input PATH           Add an AWS cost/usage export (repeatable)
  --dependency-audit PATH    Add an npm/pnpm/cargo/pip/OSV audit (repeatable)
  --exclude PATTERN          Exclude a relative path/glob locally (repeatable)
  --discover-ai-history      Find sessions whose first metadata-record cwd
                             exactly matches the scan root (Claude/Codex only)
  --no-prompt                Skip guided AI metadata discovery and the optional
                             file offer (implied by --yes)
  --json PATH                Write the full validated public API response
  --html PATH                Write a locally rendered HTML report
  --verify-against PATH      Compare this scan with a prior signed Check JSON
                             locally; never sends the prior report or its path
  --list-files               List every selected source-relative path locally
  --timeout SECONDS          Upload and response-header deadline (default ${REQUEST_TIMEOUT.defaultSeconds},
                             max ${REQUEST_TIMEOUT.maxSeconds}); also
                             PROVENEX_CHECK_TIMEOUT_MS in milliseconds
  --dry-run                  Print the exact preflight; upload nothing
  --yes                      Approve the displayed upload non-interactively
                             without discovering or including AI history
  --force                    Replace existing regular report files
  --max-files N              Source-file limit (default 5000, max 10000)
  --max-file-bytes N         Per-file limit (default 1048576, max 4194304)
  --max-artifact-bytes N     Per-artifact limit (default 16777216, max 67108864)
  --max-total-bytes N        Aggregate limit (default/max 67108864)
  --help                     Show this help
  --version                  Show the version

The production API key is read only from PROVENEX_API_KEY or an owner-only
config file at ~/.config/provenex/check.json (or
$XDG_CONFIG_HOME/provenex/check.json). Loopback development endpoints read
only PROVENEX_CHECK_DEV_API_KEY and never fall back to a production key/config.
PROVENEX_CHECK_API_URL follows the same loopback-only override rule as
--api-url; arbitrary remote origins are rejected before any key is read.
Known Provenex, Codex, and Claude credential stores are always excluded from
collection. Known Claude/Codex AI-history roots and conversations.json exports
are never swept as ordinary source. Their local paths are not displayed or
uploaded; use the explicit AI-history options to consent to session evidence.
Scanning the canonical home directory is refused; select a project subtree.`;
}

const TELEMETRY_FORMATS = new Set([
  'otel', 'otlp', 'otel-genai', 'langfuse', 'langsmith', 'langchain',
  'chatgpt', 'openai', 'okta', 'bedrock', 'aws',
  'm365', 'copilot', 'm365-copilot', 'anthropic', 'anthropic-compliance',
  'gws', 'google', 'google-workspace', 'github', 'salesforce', 'sfdc', 'mcp',
  'shopify', 'data-activity', 'data_activity', 'slack', 'slack-audit',
  'slack-enterprise',
]);

function takeValue(argv, index, inlineValue, flag) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) throw new UsageError(`${flag} requires a value`);
    return { value: inlineValue, next: index };
  }
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return { value: argv[index + 1], next: index + 1 };
}

function positiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${flag} is too large`);
  return parsed;
}

export function parseArgs(argv, env = process.env) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  if (argv.length === 1 && argv[0] === '--version') return { version: true };

  let command = argv.length === 0 ? 'plan' : 'scan';
  let argumentStart = 0;
  if (argv[0] === 'scan' || argv[0] === 'audit' || argv[0] === 'demo' || argv[0] === 'plan' || argv[0] === 'capabilities') {
    command = argv[0];
    argumentStart = 1;
  } else if (argv.length > 0 && !argv[0].startsWith('--')) {
    throw new UsageError(`expected "demo", "plan", "capabilities", "scan", or "audit"; run with --help for usage`);
  }

  const options = {
    command,
    targetPath: '.',
    apiUrl: env.PROVENEX_CHECK_API_URL || 'https://api.provenex.ai',
    artifacts: [],
    excludes: [],
    outputs: {},
    verifyAgainst: null,
    listFiles: false,
    requestTimeoutMs: null,
    dryRun: false,
    discoverAiHistory: false,
    yes: false,
    noPrompt: false,
    force: false,
    telemetryFormat: 'otel',
    telemetryFormatExplicit: false,
    limits: {
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      maxArtifactBytes: 16_777_216,
      maxTotalBytes: 67_108_864,
    },
  };
  const positionals = [];

  for (let index = argumentStart; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }
    const equals = raw.indexOf('=');
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);

    if (flag === '--help') return { help: true };
    if (flag === '--version') return { version: true };
    if (flag === '--dry-run' || flag === '--yes' || flag === '--force' || flag === '--discover-ai-history' || flag === '--no-prompt' || flag === '--list-files') {
      if (inlineValue !== undefined) throw new UsageError(`${flag} does not take a value`);
      if (flag === '--dry-run') options.dryRun = true;
      if (flag === '--yes') options.yes = true;
      if (flag === '--force') options.force = true;
      if (flag === '--discover-ai-history') options.discoverAiHistory = true;
      if (flag === '--no-prompt') options.noPrompt = true;
      if (flag === '--list-files') options.listFiles = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option: ${flag}`);

    const taken = takeValue(argv, index, inlineValue, flag);
    index = taken.next;
    if (ARTIFACT_FLAGS.has(flag)) {
      options.artifacts.push({ kind: ARTIFACT_FLAGS.get(flag), path: taken.value });
    } else if (flag === '--exclude') {
      options.excludes.push(taken.value);
    } else if (flag === '--api-url') {
      options.apiUrl = taken.value;
    } else if (flag === '--json') {
      options.outputs.json = taken.value;
    } else if (flag === '--html') {
      options.outputs.html = taken.value;
    } else if (flag === '--verify-against') {
      options.verifyAgainst = path.resolve(taken.value);
    } else if (flag === '--timeout') {
      const seconds = positiveInteger(taken.value, flag);
      if (seconds > REQUEST_TIMEOUT.maxSeconds) {
        throw new UsageError(`--timeout cannot exceed ${REQUEST_TIMEOUT.maxSeconds} seconds`);
      }
      options.requestTimeoutMs = seconds * 1000;
    } else if (flag === '--max-files') {
      options.limits.maxFiles = positiveInteger(taken.value, flag);
    } else if (flag === '--max-file-bytes') {
      options.limits.maxFileBytes = positiveInteger(taken.value, flag);
    } else if (flag === '--max-artifact-bytes') {
      options.limits.maxArtifactBytes = positiveInteger(taken.value, flag);
    } else if (flag === '--max-total-bytes') {
      options.limits.maxTotalBytes = positiveInteger(taken.value, flag);
    } else if (flag === '--telemetry-format') {
      const format = taken.value.trim().toLowerCase();
      if (!TELEMETRY_FORMATS.has(format)) {
        throw new UsageError(`unsupported --telemetry-format; run with --help for usage`);
      }
      options.telemetryFormat = format;
      options.telemetryFormatExplicit = true;
    }
  }

  if (positionals.length > 1) throw new UsageError('only one scan path may be supplied');
  if (command === 'capabilities' || command === 'demo') {
    if (positionals.length > 0) throw new UsageError(`${command} does not take a path`);
  } else if (positionals.length === 1) {
    options.targetPath = positionals[0];
  }
  options.targetPath = path.resolve(options.targetPath);
  for (const artifact of options.artifacts) {
    if (artifact.kind === 'telemetry') artifact.format = options.telemetryFormat;
  }

  if (command === 'demo' || command === 'plan' || command === 'capabilities') {
    if (
      options.artifacts.length > 0
      || options.excludes.length > 0
      || options.dryRun
      || options.yes
      || options.noPrompt
      || options.discoverAiHistory
      || options.outputs.json
      || options.outputs.html
      || options.verifyAgainst
      || options.requestTimeoutMs !== null
      || options.listFiles
    ) {
      throw new UsageError(`${command} does not upload evidence; use scan or audit`);
    }
    return options;
  }

  if (options.requestTimeoutMs === null && env.PROVENEX_CHECK_TIMEOUT_MS) {
    const milliseconds = positiveInteger(
      env.PROVENEX_CHECK_TIMEOUT_MS,
      'PROVENEX_CHECK_TIMEOUT_MS',
    );
    if (milliseconds > REQUEST_TIMEOUT.maxSeconds * 1000) {
      throw new UsageError(
        `PROVENEX_CHECK_TIMEOUT_MS cannot exceed ${REQUEST_TIMEOUT.maxSeconds * 1000}`,
      );
    }
    options.requestTimeoutMs = milliseconds;
  }

  if (options.limits.maxFiles > SERVER_LIMITS.maxSourceFiles) {
    throw new UsageError(`--max-files cannot exceed ${SERVER_LIMITS.maxSourceFiles}`);
  }
  if (options.limits.maxFileBytes > SERVER_LIMITS.maxSourceFileBytes) {
    throw new UsageError('--max-file-bytes cannot exceed 4194304');
  }
  if (options.limits.maxArtifactBytes > SERVER_LIMITS.maxArtifactBytes) {
    throw new UsageError('--max-artifact-bytes cannot exceed 67108864');
  }
  if (options.limits.maxTotalBytes > SERVER_LIMITS.maxAggregateContentBytes) {
    throw new UsageError('--max-total-bytes cannot exceed 67108864');
  }
  if (options.limits.maxFileBytes > options.limits.maxTotalBytes) {
    throw new UsageError('--max-file-bytes cannot exceed --max-total-bytes');
  }
  if (options.limits.maxArtifactBytes > options.limits.maxTotalBytes) {
    throw new UsageError('--max-artifact-bytes cannot exceed --max-total-bytes');
  }
  if (options.excludes.length > EXCLUDE_LIMITS.maxPatterns) {
    throw new UsageError(`--exclude cannot be repeated more than ${EXCLUDE_LIMITS.maxPatterns} times`);
  }
  for (const pattern of options.excludes) {
    if (
      pattern.length === 0
      || Buffer.byteLength(pattern) > EXCLUDE_LIMITS.maxPatternBytes
      || pattern.startsWith('/')
      || pattern.startsWith('!')
      || pattern.includes('\\')
      || pattern.includes(':')
      || pattern.includes('//')
      || /[\u0000-\u001f\u007f]/u.test(pattern)
      || pattern.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new UsageError(
        '--exclude must be a bounded relative pattern using /, *, ?, and ** without . or .. components',
      );
    }
  }
  if (command === 'scan') {
    const runtimeKinds = options.artifacts.filter((item) => ['fly_log', 'cloudwatch_log', 'aws_cost'].includes(item.kind));
    if (runtimeKinds.length > 0) {
      throw new UsageError('Fly, CloudWatch, and AWS cost artifacts require the audit command');
    }
  }
  if (command !== 'scan' && options.verifyAgainst) {
    throw new UsageError('--verify-against is available only with scan');
  }
  if (options.dryRun && options.verifyAgainst) {
    throw new UsageError('--verify-against requires a completed scan and cannot be used with --dry-run');
  }
  return options;
}
