import { open } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';

const PEEK_BYTES = 256 * 1024;
const OTEL_FAMILY = new Set(['', 'otel', 'otlp', 'otel-genai', 'langfuse', 'langsmith', 'langchain']);
const REFUSED_BASENAMES = new Set([
  'state.vscdb',
  'state.vscdb.backup',
  'cookies',
  'cookies.sqlite',
  'login data',
  'logins.json',
  'key4.db',
  'places.sqlite',
]);

function quoteLocalPath(value) {
  const terminalSafe = [...String(value)].map((character) => (
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character)
      ? `\\u{${character.codePointAt(0).toString(16)}}`
      : character
  )).join('');
  return JSON.stringify(terminalSafe);
}

export const EVIDENCE_CATALOG = `Other evidence Provenex can join with this project:

  conversations.json       ChatGPT or Claude product export
  runtime trace JSON       OTLP, Langfuse, LangSmith, LangChain, or Bedrock
  GitHub audit-log JSON    Organization/enterprise audit log, not Actions logs
  dependency audit JSON    npm, pnpm, cargo, pip, or OSV output
  audit command only       Fly, CloudWatch, or AWS cost export

Cursor databases, browser profiles, and login stores are never accepted.
Enter one local file at a time. An empty path continues to the upload preflight.
`;

export function shouldOfferEvidence(options, { input = stdin, output = stdout } = {}) {
  if (options.yes || options.noPrompt) return false;
  if (options.command !== 'scan' && options.command !== 'audit') return false;
  return Boolean(input?.isTTY && output?.isTTY);
}

export function sniffTelemetryFormat(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (looksLikeOtlp(value) || looksLikeLangfuse(value) || looksLikeLangsmith(value)) return 'otel';
  if (looksLikeGithubAudit(value)) return 'github';
  if (looksLikeChatgptAudit(value)) return 'chatgpt';
  if (looksLikeBedrock(value)) return 'bedrock';
  return null;
}

export function classifyEvidencePath(filePath, text, { command = 'scan' } = {}) {
  const basename = path.basename(filePath);
  const lower = basename.toLowerCase();
  if (REFUSED_BASENAMES.has(lower) || lower.endsWith('.vscdb')) {
    return {
      skip: true,
      note: 'Cursor databases and browser login stores are never accepted.',
    };
  }
  if (lower === 'conversations.json') {
    return {
      kind: 'session',
      note: 'ChatGPT/Claude web export (conversations.json).',
    };
  }
  if (path.extname(lower) === '.jsonl') {
    return {
      kind: 'session',
      note: 'JSONL session history.',
    };
  }
  if (looksLikeDependencyAudit(text)) {
    return {
      kind: 'dependency_audit',
      note: 'Local dependency advisory JSON.',
    };
  }
  const format = sniffTelemetryFormat(text);
  if (format === 'github') {
    return {
      kind: 'telemetry',
      format: 'github',
      note: 'GitHub org/enterprise audit-log JSON (not Actions job logs).',
    };
  }
  if (format === 'chatgpt') {
    return {
      kind: 'telemetry',
      format: 'chatgpt',
      note: 'ChatGPT enterprise audit-log JSON. For chat bodies, use conversations.json with --session-input.',
    };
  }
  if (format === 'bedrock') {
    return {
      kind: 'telemetry',
      format: 'bedrock',
      note: 'Bedrock invocation / FilterLogEvents JSON.',
    };
  }
  if (format === 'otel') {
    return {
      kind: 'telemetry',
      format: 'otel',
      note: 'Runtime traces (OTLP, Langfuse JSON, LangSmith REST, or LangChain OpenLLMetry).',
    };
  }
  if (looksLikeCloudwatchFilter(text)) {
    if (command === 'audit') {
      return {
        kind: 'cloudwatch_log',
        note: 'CloudWatch FilterLogEvents JSON.',
      };
    }
    return {
      skip: true,
      note: 'CloudWatch log exports need the audit command; skipping.',
    };
  }
  if (looksLikeCostExport(text)) {
    if (command === 'audit') {
      return {
        kind: 'aws_cost',
        note: 'AWS cost/usage export.',
      };
    }
    return {
      skip: true,
      note: 'Cost Explorer / CUR exports need the audit command; skipping.',
    };
  }
  return {
    kind: 'telemetry',
    format: 'otel',
    note: 'Unrecognized JSON; sending as runtime telemetry (OTLP/JSON). Prefer Langfuse, LangSmith, OTLP, or GitHub audit-log JSON.',
  };
}

export async function offerEvidence(options, {
  question,
  writeln = (line) => stdout.write(`${line}\n`),
  peekFile = peekUtf8,
  aiHistoryDiscovery = { status: 'none', matches: [] },
} = {}) {
  const matches = Array.isArray(aiHistoryDiscovery.matches) ? aiHistoryDiscovery.matches : [];
  if (aiHistoryDiscovery.status === 'found') {
    const count = matches.length;
    writeln(`Local AI history: found ${count} Claude/Codex session${count === 1 ? '' : 's'} for this exact project.`);
    if (options.discoverAiHistory) {
      writeln('Inclusion was explicitly requested with --discover-ai-history.');
    } else {
      const answer = String(await question(
        `Review ${count === 1 ? 'it' : 'them'} alongside this project scan? This version does not yet join a session action to a source path. Full session contents are sent only after the upload preflight and approval. [Y/n] `,
      )).trim();
      options.discoverAiHistory = answer === '' || /^y(es)?$/i.test(answer);
      if (!options.discoverAiHistory) {
        writeln('Local AI history: found, not included.');
      }
    }
  } else if (aiHistoryDiscovery.status === 'none') {
    writeln('Local AI history: none found for this exact project.');
  } else {
    writeln('Local AI history: unavailable; the bounded metadata check could not finish safely, so no sessions will be included.');
    if (options.discoverAiHistory) {
      writeln('This run cannot honor the explicit --discover-ai-history request and will stop before collection.');
      return options;
    }
  }

  const addAnother = String(await question(
    'Add another evidence file (trace, export, audit log, or advisory)? [y/N] ',
  )).trim();
  if (!/^y(es)?$/i.test(addAnother)) return options;

  writeln(EVIDENCE_CATALOG.trimEnd());
  for (;;) {
    const answer = String(await question('Add an evidence file path (empty to continue): ')).trim();
    if (!answer) break;
    const resolved = path.resolve(answer);
    if (options.artifacts.some((item) => path.resolve(item.path) === resolved)) {
      writeln(`Already selected: ${quoteLocalPath(resolved)}`);
      continue;
    }
    let text;
    try {
      text = await peekFile(resolved);
    } catch {
      writeln(`Could not read ${quoteLocalPath(resolved)}; it was not selected.`);
      continue;
    }
    const classified = classifyEvidencePath(resolved, text, { command: options.command });
    if (classified.skip) {
      writeln(classified.note);
      continue;
    }
    if (
      options.command === 'scan'
      && ['fly_log', 'cloudwatch_log', 'aws_cost'].includes(classified.kind)
    ) {
      writeln(`${classified.note} These require the audit command; skipping.`);
      continue;
    }
    const artifact = { kind: classified.kind, path: resolved, fromPrompt: true };
    if (classified.kind === 'telemetry') artifact.format = classified.format || 'otel';
    options.artifacts.push(artifact);
    writeln(`Queued ${classified.kind}${artifact.format ? ` (${artifact.format})` : ''} from ${quoteLocalPath(resolved)}: ${classified.note}`);
  }
  return options;
}

export async function applyTelemetryFormats(options, { peekFile = peekUtf8 } = {}) {
  for (const artifact of options.artifacts) {
    if (artifact.kind !== 'telemetry') continue;
    const locked = options.telemetryFormatExplicit && !artifact.fromPrompt;
    if (locked) {
      artifact.format = options.telemetryFormat;
      continue;
    }
    if (artifact.format && !OTEL_FAMILY.has(artifact.format)) continue;
    let text;
    try {
      text = await peekFile(path.resolve(artifact.path));
    } catch {
      artifact.format = artifact.format || options.telemetryFormat || 'otel';
      continue;
    }
    artifact.format = sniffTelemetryFormat(text) || artifact.format || options.telemetryFormat || 'otel';
  }
  return options;
}

async function peekUtf8(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, PEEK_BYTES);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function looksLikeOtlp(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.resourceSpans)) {
    return true;
  }
  return Array.isArray(value) && value.some((item) => item && typeof item === 'object' && Array.isArray(item.resourceSpans));
}

function looksLikeLangfuse(value) {
  const candidates = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push(value);
  if (Array.isArray(value) && value[0] && typeof value[0] === 'object') candidates.push(value[0]);
  return candidates.some((item) => {
    if (!Array.isArray(item.observations)) return false;
    return item.observations.some((obs) => obs && typeof obs === 'object' && (obs.type || obs.parentObservationId));
  });
}

function looksLikeLangsmith(value) {
  const runs = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.id && value.run_type) runs.push(value);
    if (Array.isArray(value.runs)) runs.push(...value.runs);
  }
  if (Array.isArray(value)) runs.push(...value);
  return runs.some((run) => run && typeof run === 'object' && run.id && run.run_type);
}

function looksLikeGithubAudit(value) {
  const first = firstEvent(value);
  return Boolean(first && typeof first.action === 'string' && first.run_type === undefined && first.message === undefined);
}

function looksLikeChatgptAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    return false;
  }
  const first = value.data[0];
  return Boolean(first && typeof first === 'object' && typeof first.type === 'string' && (first.type.includes('.') || first.actor));
}

function looksLikeBedrock(value) {
  if (isBedrockRecord(value)) return true;
  if (Array.isArray(value) && value.some(isBedrockRecord)) return true;
  if (value && typeof value === 'object' && Array.isArray(value.events)) {
    return value.events.some((event) => {
      if (isBedrockRecord(event)) return true;
      if (typeof event?.message !== 'string') return false;
      try {
        return isBedrockRecord(JSON.parse(event.message));
      } catch {
        return false;
      }
    });
  }
  return false;
}

function isBedrockRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.schemaType === 'ModelInvocationLog'
    || value.eventSource === 'bedrock.amazonaws.com'
    || (value.agentId && value.trace)
    || (value.agentName && value.trace_parts);
}

function looksLikeCloudwatchFilter(text) {
  try {
    const value = JSON.parse(text);
    const events = value?.events;
    return Array.isArray(events) && events[0] && typeof events[0].message === 'string' && !looksLikeBedrock(value);
  } catch {
    return false;
  }
}

function looksLikeCostExport(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return false;
    return Array.isArray(value.ResultsByTime)
      || Array.isArray(value.DimensionValueAttributes)
      || (typeof value.Total === 'object' && value.Total !== null);
  } catch {
    return false;
  }
}

function looksLikeDependencyAudit(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return false;
    return Boolean(
      value.vulnerabilities
      || value.advisories
      || value.auditReportVersion
      || (Array.isArray(value.matches) && (value.database || value.source))
      || Array.isArray(value.vulnerabilities),
    );
  } catch {
    return false;
  }
}

function firstEvent(value) {
  if (Array.isArray(value)) return value[0];
  if (value && typeof value === 'object') {
    if (Array.isArray(value.events)) return value.events[0];
    if (Array.isArray(value.items)) return value.items[0];
  }
  return undefined;
}
