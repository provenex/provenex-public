import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyTelemetryFormats,
  classifyEvidencePath,
  EVIDENCE_CATALOG,
  offerEvidence,
  shouldOfferEvidence,
  sniffTelemetryFormat,
} from '../src/prompt.mjs';

test('catalog names working surfaces and refuses cursor/browser stores', () => {
  assert.match(EVIDENCE_CATALOG, /conversations\.json/);
  assert.match(EVIDENCE_CATALOG, /Langfuse/);
  assert.match(EVIDENCE_CATALOG, /LangSmith/);
  assert.match(EVIDENCE_CATALOG, /audit-log/);
  assert.match(EVIDENCE_CATALOG, /not Actions logs/);
  assert.match(EVIDENCE_CATALOG, /Cursor databases/);
  assert.doesNotMatch(EVIDENCE_CATALOG, /PVX-|confused-deputy|gadget-chain|echoleak/);
});

test('shouldOfferEvidence skips automation and non-TTY', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(shouldOfferEvidence({ command: 'scan', yes: false, noPrompt: false }, { input: tty, output: tty }), true);
  assert.equal(shouldOfferEvidence({ command: 'scan', yes: true, noPrompt: false }, { input: tty, output: tty }), false);
  assert.equal(shouldOfferEvidence({ command: 'scan', yes: false, noPrompt: true }, { input: tty, output: tty }), false);
  assert.equal(shouldOfferEvidence({ command: 'plan', yes: false, noPrompt: false }, { input: tty, output: tty }), false);
  assert.equal(shouldOfferEvidence({ command: 'scan', yes: false, noPrompt: false }, { input: pipe, output: tty }), false);
});

test('sniffTelemetryFormat recognizes vendor envelopes', () => {
  assert.equal(sniffTelemetryFormat('{"resourceSpans":[]}'), 'otel');
  assert.equal(sniffTelemetryFormat('{"trace":{"id":"t1"},"observations":[{"id":"o1","type":"GENERATION"}]}'), 'otel');
  assert.equal(sniffTelemetryFormat('{"id":"abc","run_type":"chain","inputs":{}}'), 'otel');
  assert.equal(sniffTelemetryFormat('[{"action":"git.clone","@timestamp":1,"actor":"ada"}]'), 'github');
  assert.equal(sniffTelemetryFormat('{"object":"list","data":[{"id":"1","type":"login.succeeded","actor":{"type":"user"}}]}'), 'chatgpt');
  assert.equal(sniffTelemetryFormat('{"schemaType":"ModelInvocationLog"}'), 'bedrock');
  assert.equal(sniffTelemetryFormat('{"events":[{"timestamp":1,"message":"error"}]}'), null);
});

test('classifyEvidencePath routes exports and refuses databases', () => {
  assert.equal(classifyEvidencePath('/tmp/conversations.json', '{}').kind, 'session');
  assert.equal(classifyEvidencePath('/tmp/agent.jsonl', '{}\n').kind, 'session');
  assert.equal(classifyEvidencePath('/tmp/npm-audit.json', '{"auditReportVersion":2,"vulnerabilities":{}}').kind, 'dependency_audit');
  assert.equal(classifyEvidencePath('/tmp/audit.json', '[{"action":"repo.download_zip"}]').format, 'github');
  assert.equal(classifyEvidencePath('/tmp/state.vscdb', '').skip, true);
  const cloudwatchOnScan = classifyEvidencePath(
    '/tmp/cw.json',
    '{"events":[{"timestamp":1,"message":"error"}]}',
    { command: 'scan' },
  );
  assert.equal(cloudwatchOnScan.skip, true);
  const cloudwatchOnAudit = classifyEvidencePath(
    '/tmp/cw.json',
    '{"events":[{"timestamp":1,"message":"error"}]}',
    { command: 'audit' },
  );
  assert.equal(cloudwatchOnAudit.kind, 'cloudwatch_log');
});

test('offerEvidence asks about exact-project AI history first and defaults to inclusion', async () => {
  const answers = ['', ''];
  const questions = [];
  const lines = [];
  const options = { command: 'scan', artifacts: [], discoverAiHistory: false };
  await offerEvidence(options, {
    question: async (query) => {
      questions.push(query);
      return answers.shift() ?? '';
    },
    writeln: (line) => lines.push(line),
    aiHistoryDiscovery: {
      status: 'found',
      matches: [{ kind: 'session', path: '/opaque/one.jsonl' }],
      error: null,
    },
  });

  assert.equal(options.discoverAiHistory, true);
  assert.equal(options.artifacts.length, 0);
  assert.match(lines[0], /Local AI history: found 1/);
  assert.match(questions[0], /does not yet join a session action to a source path/);
  assert.match(questions[0], /Full session contents/);
  assert.match(questions[0], /\[Y\/n\]/);
  assert.match(questions[1], /Add another evidence file/);
  assert.doesNotMatch(lines.join('\n'), /Other evidence Provenex/);
});

test('offerEvidence quotes path diagnostics and never renders raw OS errors', async () => {
  const hostilePath = `/tmp/evidence-${String.fromCharCode(0x1b)}[31m.json`;
  const answers = ['yes', hostilePath, ''];
  const lines = [];
  const options = { command: 'scan', artifacts: [], discoverAiHistory: false };
  await offerEvidence(options, {
    question: async () => answers.shift() ?? '',
    writeln: (line) => lines.push(line),
    peekFile: async () => {
      throw new Error(`raw-${String.fromCharCode(0x1b)}-error`);
    },
    aiHistoryDiscovery: { status: 'none', matches: [], error: null },
  });

  const rendered = lines.join('\n');
  assert.doesNotMatch(rendered, /\u001b/u);
  assert.match(rendered, /\\u\{1b\}/u);
  assert.doesNotMatch(rendered, /raw-|error/u);
  assert.equal(options.artifacts.length, 0);
});

test('offerEvidence keeps declined AI history out, then expands optional file help', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'provenex-prompt-'));
  try {
    const langfuse = path.join(directory, 'langfuse.json');
    const github = path.join(directory, 'github.json');
    await writeFile(langfuse, '{"trace":{"id":"t1"},"observations":[{"id":"o1","type":"GENERATION"}]}');
    await writeFile(github, '[{"action":"git.clone","@timestamp":1,"actor":"ada"}]');
    const answers = ['no', 'yes', langfuse, github, ''];
    const options = { command: 'scan', artifacts: [], discoverAiHistory: false };
    const lines = [];
    await offerEvidence(options, {
      question: async () => answers.shift() ?? '',
      writeln: (line) => lines.push(line),
      aiHistoryDiscovery: {
        status: 'found',
        matches: [
          { kind: 'session', path: '/opaque/one.jsonl' },
          { kind: 'session', path: '/opaque/two.jsonl' },
        ],
        error: null,
      },
    });
    assert.equal(options.discoverAiHistory, false);
    assert.equal(options.artifacts.length, 2);
    assert.equal(options.artifacts[0].kind, 'telemetry');
    assert.equal(options.artifacts[0].format, 'otel');
    assert.equal(options.artifacts[1].format, 'github');
    assert.match(lines.join('\n'), /found, not included/);
    assert.match(lines.join('\n'), /Other evidence Provenex|Langfuse|GitHub|Queued/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offerEvidence distinguishes no matches from unavailable discovery', async () => {
  for (const entry of [
    { status: 'none', expected: /none found for this exact project/ },
    { status: 'unavailable', expected: /unavailable.*could not finish safely/ },
  ]) {
    const questions = [];
    const lines = [];
    const options = { command: 'scan', artifacts: [], discoverAiHistory: false };
    await offerEvidence(options, {
      question: async (query) => {
        questions.push(query);
        return '';
      },
      writeln: (line) => lines.push(line),
      aiHistoryDiscovery: { status: entry.status, matches: [], error: null },
    });
    assert.match(lines.join('\n'), entry.expected);
    assert.equal(options.discoverAiHistory, false);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Add another evidence file/);
  }
});

test('explicit AI-history selection is reported without a second consent prompt', async () => {
  const questions = [];
  const lines = [];
  const options = { command: 'scan', artifacts: [], discoverAiHistory: true };
  await offerEvidence(options, {
    question: async (query) => {
      questions.push(query);
      return '';
    },
    writeln: (line) => lines.push(line),
    aiHistoryDiscovery: {
      status: 'found',
      matches: [{ kind: 'session', path: '/opaque/one.jsonl' }],
      error: null,
    },
  });
  assert.match(lines.join('\n'), /explicitly requested with --discover-ai-history/);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Add another evidence file/);
});

test('an unavailable explicit AI-history request stops before other evidence prompts', async () => {
  let asked = false;
  const lines = [];
  const options = { command: 'scan', artifacts: [], discoverAiHistory: true };
  await offerEvidence(options, {
    question: async () => {
      asked = true;
      return '';
    },
    writeln: (line) => lines.push(line),
    aiHistoryDiscovery: {
      status: 'unavailable',
      matches: [],
      error: new Error('bounded discovery failed'),
    },
  });
  assert.equal(asked, false);
  assert.match(lines.join('\n'), /cannot honor the explicit --discover-ai-history request/);
});

test('applyTelemetryFormats sniffs unlocked --telemetry files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'provenex-prompt-fmt-'));
  try {
    const github = path.join(directory, 'github.json');
    await writeFile(github, '[{"action":"git.clone","@timestamp":1}]');
    const options = {
      telemetryFormat: 'otel',
      telemetryFormatExplicit: false,
      artifacts: [{ kind: 'telemetry', path: github, format: 'otel' }],
    };
    await applyTelemetryFormats(options);
    assert.equal(options.artifacts[0].format, 'github');

    const locked = {
      telemetryFormat: 'otel',
      telemetryFormatExplicit: true,
      artifacts: [{ kind: 'telemetry', path: github, format: 'otel' }],
    };
    await applyTelemetryFormats(locked);
    assert.equal(locked.artifacts[0].format, 'otel');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
