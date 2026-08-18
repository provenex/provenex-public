import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { targetLabelForRoot } from '../src/collector.mjs';
import { DISCOVERY_LIMITS, SERVER_LIMITS } from '../src/limits.mjs';
import { atomicWrite } from '../src/output.mjs';
import { CHECK_DATA_POLICY } from '../src/policy.mjs';
import { validateHostedResponse } from '../src/report.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'provenex-check.js');
const TEST_TOKEN = 'pvx_test_token_never_print_this';
const TEST_KEYS = generateKeyPairSync('ed25519');
const TEST_PUBLIC_KEY = TEST_KEYS.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const TEST_PUBLIC_KEY_SHA256 = createHash('sha256').update(TEST_PUBLIC_KEY).digest('hex');

function canonicalForTest(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
}

function publicFinding(overrides = {}) {
  return {
    id: 'finding-0001',
    category: 'application_security',
    disposition: 'requires_review',
    evidence_level: 'direct',
    title: 'Review a security finding',
    consequence: 'A production boundary could be weaker than intended.',
    evidence: 'A sanitized deterministic source signal was observed.',
    next_step: 'Review the affected boundary before deployment.',
    ...overrides,
  };
}

function validResponse({
  target = 'sample-project',
  command = 'scan',
  status = 'complete',
  generatedAt = '2026-08-18T12:34:56.123Z',
  findings = [],
  coverage = [{
    id: 'coverage-0001',
    category: 'application_security',
    status: 'evaluated',
    detail: 'Selected source evidence was evaluated within the declared bounds.',
  }],
  limitations = ['Only explicitly approved evidence was evaluated.'],
  retentionPolicy = CHECK_DATA_POLICY,
} = {}) {
  const counts = { direct: 0, correlated: 0, tentative: 0 };
  findings.forEach((finding) => { counts[finding.evidence_level] += 1; });
  const report = {
    schema_version: 'provenex-check-public-report.v1',
    tool_version: '0.1.0-alpha.2',
    command,
    target,
    generated_at: generatedAt,
    status,
    summary: { total: findings.length, ...counts },
    conclusion: findings.length > 0
      ? 'Review the emitted findings and coverage before deployment.'
      : 'No findings were emitted for the approved evidence and declared coverage.',
    findings,
    coverage,
    limitations,
  };
  const canonicalReport = canonicalForTest(report);
  const signature = sign(null, Buffer.from(canonicalReport, 'utf8'), TEST_KEYS.privateKey).toString('hex');
  return {
    schema_version: 'provenex-check-response.v1',
    run_id: '123e4567-e89b-42d3-a456-426614174000',
    exit_code: status === 'incomplete' ? 3 : findings.length > 0 ? 1 : 0,
    status,
    service_release: 'check-api-2026-08-18.alpha1',
    retention_policy: { ...retentionPolicy },
    signed_report: {
      schema_version: 'provenex-check-signed-report.v1',
      report,
      canonical_report_json: canonicalReport,
      signature: {
        algorithm: 'ed25519',
        key_id: `run-${TEST_PUBLIC_KEY_SHA256.slice(0, 16)}`,
        public_key: TEST_PUBLIC_KEY.toString('hex'),
        public_key_sha256: TEST_PUBLIC_KEY_SHA256,
        signature,
        meaning: 'self-consistency-only',
      },
    },
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'provenex-check-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function makeProject(t, { files = { 'app.js': 'export const value = 1;\n' } } = {}) {
  const base = await temporaryDirectory(t);
  const project = path.join(base, 'sample-project');
  const reports = path.join(base, 'reports');
  const config = path.join(base, 'config');
  await mkdir(project);
  await mkdir(reports);
  await mkdir(config);
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(project, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return { base, project, reports, config };
}

function runCli(args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROVENEX_API_KEY: '',
        PROVENEX_CHECK_API_URL: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function mockServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('no subcommand defaults to scan and dry-run reads no key or AI history', async (t) => {
  const { project, config } = await makeProject(t);
  const result = await runCli(['--dry-run', project], {
    env: { XDG_CONFIG_HOME: config },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Command: scan/);
  assert.match(result.stdout, /AI history: not requested/);
  assert.match(result.stdout, /central multi-tenant/);
  assert.match(result.stdout, /nothing was uploaded and no API key was read/);
});

test('posts the public request shape, writes explicit outputs, and preserves server exit', async (t) => {
  const { base, project, reports, config } = await makeProject(t);
  await writeFile(path.join(project, '.gitignore'), '.env\n');
  await writeFile(path.join(project, '.env'), 'DATABASE_URL=postgres://example.invalid/test\n');
  const outside = path.join(base, 'outside.js');
  await writeFile(outside, 'doNotUpload();\n');
  await symlink(outside, path.join(project, 'linked.js'));
  const session = path.join(base, 'customer-and-session-id-123.jsonl');
  await writeFile(session, '{"type":"assistant","message":"hello"}\n');

  assert.equal(spawnSync('git', ['init', '-q', project], { shell: false }).status, 0);
  assert.equal(spawnSync('git', ['-C', project, 'add', 'app.js', '.gitignore'], { shell: false }).status, 0);

  let captured;
  let authorization;
  const serverResponse = validResponse({
    findings: [publicFinding({ title: 'Review seven findings' })],
  });
  const origin = await mockServer(t, async (request, response) => {
    assert.equal(request.url, '/v1/check/runs');
    authorization = request.headers.authorization;
    captured = JSON.parse(await readRequest(request));
    const body = JSON.stringify(serverResponse);
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });

  const jsonOutput = path.join(reports, 'report.json');
  const htmlOutput = path.join(reports, 'report.html');
  const result = await runCli([
    'scan', project,
    '--api-url', origin,
    '--yes',
    '--session-input', session,
    '--json', jsonOutput,
    '--html', htmlOutput,
  ], {
    env: { PROVENEX_API_KEY: TEST_TOKEN, XDG_CONFIG_HOME: config },
  });

  assert.equal(result.code, 1, result.stderr);
  assert.equal(authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(captured.schema_version, 'provenex-check-request.v1');
  assert.equal(captured.command, 'scan');
  assert.equal(captured.target, path.basename(project));
  assert.deepEqual(captured.consent.approved, true);
  assert.equal(captured.consent.policy_id, CHECK_DATA_POLICY.policy_id);
  assert.ok(captured.consent.categories.includes('environment_secrets'));
  assert.ok(captured.consent.categories.includes('ai_session_history'));
  assert.deepEqual(captured.artifacts.map(({ kind, name }) => ({ kind, name })), [
    { kind: 'session', name: 'session-001.jsonl' },
  ]);
  assert.ok(!JSON.stringify(captured.artifacts).includes(path.basename(session)));
  assert.deepEqual(captured.source_files.map((file) => file.relative_path).sort(), ['.env', 'app.js']);
  assert.equal(captured.source_files.find((file) => file.relative_path === 'app.js').git_state, 'tracked');
  assert.equal(captured.source_files.find((file) => file.relative_path === '.env').git_state, 'ignored');
  assert.ok(!captured.source_files.some((file) => file.relative_path === 'linked.js'));
  assert.deepEqual(JSON.parse(await readFile(jsonOutput, 'utf8')), serverResponse);
  const html = await readFile(htmlOutput, 'utf8');
  assert.match(html, /Provenex Check/);
  assert.ok(!html.includes('<script'));
  assert.match(result.stdout, /Review seven findings/);
  assert.match(result.stdout, /self-consistency checking only/);
  assert.match(result.stdout, /Data policy: provenex-check-ephemeral-v1/);
  assert.ok(result.stdout.includes(session));
  assert.ok(!result.stdout.includes(TEST_TOKEN));
  assert.ok(!result.stderr.includes(TEST_TOKEN));
});

test('non-interactive upload without --yes fails before reading a key or calling API', async (t) => {
  const { project, config } = await makeProject(t);
  let requests = 0;
  const origin = await mockServer(t, (_request, response) => {
    requests += 1;
    response.end();
  });
  const result = await runCli(['scan', project, '--api-url', origin], {
    env: { XDG_CONFIG_HOME: config },
  });
  assert.equal(result.code, 2);
  assert.equal(requests, 0);
  assert.match(result.stdout, /upload preflight/);
  assert.match(result.stderr, /interactive approval or explicit --yes/);
});

test('missing key gives honest alpha trial instructions and remains a local usage error', async (t) => {
  const { project, config } = await makeProject(t);
  let requests = 0;
  const origin = await mockServer(t, (_request, response) => {
    requests += 1;
    response.end();
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { XDG_CONFIG_HOME: config },
  });
  assert.equal(result.code, 2);
  assert.equal(requests, 0);
  assert.match(result.stderr, /obtain a Check API key from your Provenex trial administrator/);
  assert.match(result.stderr, /self-serve signup is not available in alpha/);
});

test('rejects non-loopback HTTP as a usage error', async (t) => {
  const { project } = await makeProject(t);
  const result = await runCli(['scan', project, '--api-url', 'http://example.com', '--dry-run']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must use HTTPS/);
});

test('collection bounds and symlink artifacts fail as operational errors', async (t) => {
  const { base, project } = await makeProject(t, {
    files: { 'a.js': 'a();\n', 'b.js': 'b();\n' },
  });
  const bounded = await runCli(['scan', project, '--max-files', '1', '--dry-run']);
  assert.equal(bounded.code, 3);
  assert.match(bounded.stderr, /contains 2 files; limit is 1/);

  const artifact = path.join(base, 'real-session.jsonl');
  const linked = path.join(base, 'linked-session.jsonl');
  await writeFile(artifact, '{}\n');
  await symlink(artifact, linked);
  const symlinked = await runCli(['scan', project, '--session-input', linked, '--dry-run']);
  assert.equal(symlinked.code, 3);
  assert.match(symlinked.stderr, /must not be a symbolic link/);
});

test('report outputs reject scan overlap and symlinks', async (t) => {
  const { base, project, reports } = await makeProject(t);
  const overlap = await runCli(['scan', project, '--json', path.join(project, 'report.json'), '--dry-run']);
  assert.equal(overlap.code, 3);
  assert.match(overlap.stderr, /outside the scanned directory/);

  const real = path.join(base, 'existing.json');
  const linked = path.join(reports, 'linked.json');
  await writeFile(real, '{}\n');
  await symlink(real, linked);
  const symlinked = await runCli(['scan', project, '--json', linked, '--force', '--dry-run']);
  assert.equal(symlinked.code, 3);
  assert.match(symlinked.stderr, /symbolic-link output/);
});

test('failed report content writes remove their owner-only temporary file', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, 'report.json');
  await assert.rejects(
    atomicWrite(destination, Symbol('invalid report content'), false),
    /must be of type string|Received type symbol/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test('API failures are operational and never print a token or response body', async (t) => {
  const { project } = await makeProject(t);
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(500, { 'content-type': 'text/plain', 'x-request-id': 'safe-request-id' });
    response.end(`server accidentally echoed ${TEST_TOKEN}`);
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /HTTP 500 \(request safe-request-id\)/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_TOKEN));
  assert.ok(!result.stderr.includes('server accidentally'));
});

test('rejects legacy server-rendered and private response fields', async (t) => {
  const { project } = await makeProject(t);
  const legacy = {
    ...validResponse(),
    terminal: 'MALICIOUS_SERVER_TERMINAL',
    html_report: '<script>malicious()</script>',
    source_commit: 'a'.repeat(40),
  };
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(legacy));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /response has unsupported fields/);
  assert.ok(!result.stdout.includes('MALICIOUS_SERVER_TERMINAL'));
});

test('rejects a response whose mandatory retention policy differs from consent', async (t) => {
  const { project } = await makeProject(t);
  const mismatched = validResponse({
    retentionPolicy: { ...CHECK_DATA_POLICY, raw_evidence_retention_seconds: 60 },
  });
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mismatched));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /applied retention policy differs from consent/);
});

test('accepts opaque safe service releases and rejects unsafe release text', async (t) => {
  const { project } = await makeProject(t);
  for (const [serviceRelease, expectedCode, expectedError] of [
    ['check-api-2026-09-01.alpha2', 0, null],
    ['release\u001b[31m', 3, /service release is not a bounded opaque identifier/],
    ['x'.repeat(129), 3, /service release is not a bounded opaque identifier/],
  ]) {
    const serverResponse = validResponse();
    serverResponse.service_release = serviceRelease;
    const origin = await mockServer(t, async (request, response) => {
      await readRequest(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(serverResponse));
    });
    const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
      env: { PROVENEX_API_KEY: TEST_TOKEN },
    });
    assert.equal(result.code, expectedCode, result.stderr);
    if (expectedError) assert.match(result.stderr, expectedError);
  }
});

test('rejects impossible report timestamps and inconsistent exit semantics', () => {
  assert.throws(
    () => validateHostedResponse(
      validResponse({ generatedAt: '2026-02-31T12:34:56Z' }),
      { command: 'scan', target: 'sample-project' },
    ),
    /report generation timestamp is invalid/,
  );

  const inconsistentExit = validResponse();
  inconsistentExit.exit_code = 1;
  assert.throws(
    () => validateHostedResponse(
      inconsistentExit,
      { command: 'scan', target: 'sample-project' },
    ),
    /finding count and exit code differ/,
  );
});

test('rejects canonical-report mismatch and invalid Ed25519 signatures', async (t) => {
  const { project } = await makeProject(t);
  const cases = [];

  const canonicalMismatch = validResponse();
  const differentReport = { ...canonicalMismatch.signed_report.report, conclusion: 'A different conclusion.' };
  const differentCanonical = canonicalForTest(differentReport);
  canonicalMismatch.signed_report.canonical_report_json = differentCanonical;
  canonicalMismatch.signed_report.signature.signature = sign(
    null,
    Buffer.from(differentCanonical, 'utf8'),
    TEST_KEYS.privateKey,
  ).toString('hex');
  cases.push({ response: canonicalMismatch, message: /canonical report differs/ });

  const invalidSignature = validResponse();
  invalidSignature.signed_report.signature.signature = '00'.repeat(64);
  cases.push({ response: invalidSignature, message: /signature verification failed/ });

  for (const entry of cases) {
    const origin = await mockServer(t, async (request, response) => {
      await readRequest(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(entry.response));
    });
    const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
      env: { PROVENEX_API_KEY: TEST_TOKEN },
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, entry.message);
  }
});

test('escapes server-authored public DTO text in locally rendered HTML', async (t) => {
  const { project, reports } = await makeProject(t);
  const rendered = validResponse({
    findings: [publicFinding({ title: '<script>alert("finding")</script>' })],
  });
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(rendered));
  });
  const htmlOutput = path.join(reports, 'escaped.html');
  const result = await runCli([
    'scan', project, '--api-url', origin, '--yes', '--html', htmlOutput,
  ], { env: { PROVENEX_API_KEY: TEST_TOKEN } });
  assert.equal(result.code, 1, result.stderr);
  const html = await readFile(htmlOutput, 'utf8');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;alert\(&quot;finding&quot;\)&lt;\/script&gt;/);
  assert.match(html, /self-consistency checking only/);
});

test('bounds a successful API response before parsing it', async (t) => {
  const { project } = await makeProject(t);
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(33 * 1024 * 1024),
    });
    response.end('{}');
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /response exceeds 33554432 bytes/);
});

test('opt-in AI discovery uploads only exact-cwd sessions with opaque labels', async (t) => {
  const { base, project } = await makeProject(t);
  const fakeHome = path.join(base, 'home');
  const sessions = path.join(fakeHome, '.claude', 'projects', 'bounded');
  await mkdir(sessions, { recursive: true });
  const canonicalProject = await realpath(project);
  await writeFile(
    path.join(sessions, 'sensitive-session-id.jsonl'),
    `${JSON.stringify({ cwd: canonicalProject, type: 'user' })}\n${JSON.stringify({ message: 'matching' })}\n`,
  );
  await writeFile(
    path.join(sessions, 'other-session-id.jsonl'),
    `${JSON.stringify({ cwd: path.join(base, 'different-project') })}\n`,
  );
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    const body = JSON.stringify(validResponse());
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  const result = await runCli([
    'scan', project, '--discover-ai-history', '--api-url', origin, '--yes',
  ], {
    env: { HOME: fakeHome, PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /AI history: requested; 1 exact-cwd matches/);
  assert.match(result.stdout, /Data policy: provenex-check-ephemeral-v1/);
  assert.equal(captured.artifacts.length, 1);
  assert.equal(captured.artifacts[0].name, 'session-001.jsonl');
  assert.ok(!JSON.stringify(captured.artifacts).includes('sensitive-session-id'));
  assert.ok(!result.stdout.includes('sensitive-session-id'));
  assert.ok(!result.stdout.includes('other-session-id'));
  assert.match(captured.artifacts[0].content, /matching/);
});

test('AI discovery accounts only bounded first metadata records across large sessions', async (t) => {
  const { base, project } = await makeProject(t);
  const fakeHome = path.join(base, 'home');
  const sessions = path.join(fakeHome, '.claude', 'projects', 'many-large-sessions');
  await mkdir(sessions, { recursive: true });
  const canonicalProject = await realpath(project);

  const matchingName = 'sensitive-matching-session-id.jsonl';
  await writeFile(
    path.join(sessions, matchingName),
    `${JSON.stringify({ cwd: canonicalProject, type: 'user' })}\n${JSON.stringify({ message: 'matching' })}\n`,
  );
  for (let index = 1; index < 149; index += 1) {
    await writeFile(
      path.join(sessions, `matching-session-${String(index).padStart(3, '0')}.jsonl`),
      `${JSON.stringify({ cwd: canonicalProject, type: 'user' })}\n`,
    );
  }
  await writeFile(
    path.join(sessions, 'cwd-only-in-second-record.jsonl'),
    `${JSON.stringify({ type: 'user' })}\n${JSON.stringify({ cwd: canonicalProject })}\n`,
  );
  await writeFile(
    path.join(sessions, 'oversized-first-record.jsonl'),
    `${JSON.stringify({ cwd: canonicalProject, padding: 'x'.repeat(64 * 1024) })}\n`,
  );

  for (let index = 0; index < 129; index += 1) {
    const candidate = path.join(sessions, `large-nonmatch-${String(index).padStart(3, '0')}.jsonl`);
    await writeFile(candidate, `${JSON.stringify({ cwd: path.join(base, 'different-project') })}\n`);
    await truncate(candidate, 256 * 1024);
  }

  const result = await runCli(['scan', project, '--discover-ai-history', '--dry-run'], {
    env: { HOME: fakeHome },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /AI history: requested; 149 exact-cwd matches/);
  assert.ok(!result.stdout.includes(matchingName));
  assert.ok(!result.stdout.includes('large-nonmatch'));
  assert.ok(!result.stdout.includes('cwd-only-in-second-record'));
  assert.ok(!result.stdout.includes('oversized-first-record'));
});

test('scan rejects runtime and cost artifacts while audit accepts them', async (t) => {
  const { base, project } = await makeProject(t);
  const fly = path.join(base, 'fly.jsonl');
  await writeFile(fly, '{}\n');
  const rejected = await runCli(['scan', project, '--fly-log', fly, '--dry-run']);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /require the audit command/);

  const accepted = await runCli(['audit', project, '--fly-log', fly, '--dry-run']);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /platform_logs/);
});

test('routes an exact supported web conversations.json export without exposing its basename', async (t) => {
  const { base, project } = await makeProject(t);
  const exportDirectory = path.join(base, 'chatgpt-export');
  await mkdir(exportDirectory);
  const conversationExport = path.join(exportDirectory, 'conversations.json');
  await writeFile(conversationExport, '[{"id":"conversation","mapping":{}}]\n');
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli([
    'scan', project, '--session-input', conversationExport, '--api-url', origin, '--yes',
  ], { env: { PROVENEX_API_KEY: TEST_TOKEN } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(captured.artifacts.map(({ kind, name }) => ({ kind, name })), [{
    kind: 'conversation_export',
    name: 'conversation-export-001.json',
  }]);
  assert.ok(!captured.artifacts[0].name.includes('conversations'));
  assert.match(captured.artifacts[0].content, /conversation/);
  assert.match(result.stdout, /conversation_export/);
});

test('rejects an arbitrary JSON file passed as a session', async (t) => {
  const { base, project } = await makeProject(t);
  const arbitraryJson = path.join(base, 'session.json');
  await writeFile(arbitraryJson, '{}\n');
  const result = await runCli(['scan', project, '--session-input', arbitraryJson, '--dry-run']);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /must be a JSONL session or an exact conversations\.json/);
});

test('repeatable local excludes prune before reading and never enter the request', async (t) => {
  const { project } = await makeProject(t, {
    files: {
      'app.js': 'safe();\n',
      'private/unique-secret.js': 'mustNotLeave();\n',
      'fixtures/unique-customer.txt': 'must not leave\n',
    },
  });
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli([
    'scan', project,
    '--exclude', 'private',
    '--exclude', '*.txt',
    '--api-url', origin,
    '--yes',
  ], { env: { PROVENEX_API_KEY: TEST_TOKEN } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(captured.source_files.map((file) => file.relative_path), ['app.js']);
  assert.ok(!JSON.stringify(captured).includes('unique-secret'));
  assert.ok(!JSON.stringify(captured).includes('unique-customer'));
  assert.ok(!JSON.stringify(captured).includes('*.txt'));
  assert.match(result.stdout, /User exclusions \(local only\)/);
  assert.match(result.stdout, /2 matched entries\/directories pruned/);
});

test('invalid exclude traversal and absolute patterns fail as usage errors', async (t) => {
  const { project } = await makeProject(t);
  for (const pattern of ['../secret', '/absolute', 'safe/./secret', '!negation']) {
    const result = await runCli(['scan', project, '--exclude', pattern, '--dry-run']);
    assert.equal(result.code, 2, `${pattern}: ${result.stderr}`);
    assert.match(result.stderr, /--exclude must be a bounded relative pattern/);
  }
});

test('collects representative credential, native/mobile, and text configuration files', async (t) => {
  const representative = {
    '.envrc': 'export TOKEN=example\n',
    '.dev.vars.local': 'TOKEN=example\n',
    credentials: '[default]\nkey=example\n',
    '.npmrc': '//registry.example/:_authToken=example\n',
    '.pypirc': '[server]\npassword=example\n',
    '.netrc': 'machine example login user password example\n',
    '.dockercfg': '{}\n',
    '.dockerconfigjson': '{}\n',
    '.terraformrc': 'credentials {}\n',
    '.yarnrc': 'registry "https://example.invalid"\n',
    'data.csv': 'email\ncustomer@example.invalid\n',
    'index.html': '<main>hello</main>\n',
    'notes.txt': 'deployment note\n',
    'Config.xcconfig': 'API_URL = https://example.invalid\n',
    'BUILD.bazel': 'exports_files(["app.js"])\n',
    'project.pbxproj': '// !$*UTF8*$!\n',
  };
  const { project } = await makeProject(t, { files: { 'app.js': 'safe();\n', ...representative } });
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  const selected = new Set(captured.source_files.map((file) => file.relative_path));
  for (const filename of Object.keys(representative)) {
    assert.ok(selected.has(filename), `expected ${filename} to be collected`);
  }
  assert.ok(captured.consent.categories.includes('environment_secrets'));
  assert.match(result.stdout, /High-sensitivity source paths selected/);
  assert.match(result.stdout, /\.npmrc/);
  assert.match(result.stdout, /\.envrc/);
});

test('hosted request limits and path grammar stay aligned with the public schema', async () => {
  const schema = JSON.parse(await readFile(
    path.join(PACKAGE_ROOT, 'schemas', 'provenex-check-request.v1.schema.json'),
    'utf8',
  ));
  assert.equal(schema.properties.source_files.maxItems, SERVER_LIMITS.maxSourceFiles);
  assert.equal(schema.properties.artifacts.maxItems, SERVER_LIMITS.maxArtifacts);
  assert.equal(SERVER_LIMITS.maxArtifacts, 256);
  assert.equal(schema.properties.target['x-maxUtf8Bytes'], SERVER_LIMITS.maxTargetBytes);
  assert.equal(
    schema.properties.artifacts.items.properties.name['x-maxUtf8Bytes'],
    SERVER_LIMITS.maxArtifactNameBytes,
  );
  assert.equal(
    schema.properties.source_files.items.properties.relative_path['x-maxUtf8Bytes'],
    SERVER_LIMITS.maxRelativePathBytes,
  );
  assert.equal(
    schema.properties.source_files.items.properties.content['x-maxUtf8Bytes'],
    SERVER_LIMITS.maxSourceFileBytes,
  );
  assert.equal(
    schema.properties.artifacts.items.properties.content['x-maxUtf8Bytes'],
    SERVER_LIMITS.maxArtifactBytes,
  );
  assert.equal(schema['x-maxAggregateContentBytes'], SERVER_LIMITS.maxAggregateContentBytes);
  assert.equal(SERVER_LIMITS.maxRequestBytes, 128 * 1024 * 1024);
  assert.deepEqual(DISCOVERY_LIMITS, {
    maxCandidateFiles: 20_000,
    maxDirectoryEntries: 100_000,
    maxDirectories: 10_000,
    maxMetadataBytes: 32 * 1024 * 1024,
    maxFirstRecordBytes: 64 * 1024,
  });

  const pathPattern = new RegExp(
    schema.properties.source_files.items.properties.relative_path.pattern,
    'u',
  );
  assert.equal(pathPattern.test('src/app.js'), true);
  assert.equal(pathPattern.test('../secret'), false);
  assert.equal(pathPattern.test('src/bad:name.js'), false);
  assert.equal(pathPattern.test('src\\bad.js'), false);
  assert.equal(pathPattern.test('.git/config'), false);
});

test('public response schema exposes only the strict DTO and ephemeral envelope', async () => {
  const requestSchema = JSON.parse(await readFile(
    path.join(PACKAGE_ROOT, 'schemas', 'provenex-check-request.v1.schema.json'),
    'utf8',
  ));
  const responseSchema = JSON.parse(await readFile(
    path.join(PACKAGE_ROOT, 'schemas', 'provenex-check-response.v1.schema.json'),
    'utf8',
  ));

  assert.equal(responseSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(responseSchema.properties).sort(), [
    'exit_code',
    'retention_policy',
    'run_id',
    'schema_version',
    'service_release',
    'signed_report',
    'status',
  ]);
  assert.equal(responseSchema.properties.service_release.pattern, '^[A-Za-z0-9._-]+$');
  assert.equal(responseSchema.properties.service_release.maxLength, 128);
  assert.equal(
    responseSchema.$defs.retentionPolicy.properties.policy_id.const,
    CHECK_DATA_POLICY.policy_id,
  );
  assert.equal(responseSchema.$defs.retentionPolicy.properties.raw_evidence_retention_seconds.const, 0);
  assert.equal(responseSchema.$defs.retentionPolicy.properties.derived_results_retention_seconds.const, 0);
  assert.equal(responseSchema.$defs.retentionPolicy.properties.workspace_deleted_before_response.const, true);
  assert.equal(responseSchema.$defs.signature.properties.meaning.const, 'self-consistency-only');
  assert.ok(responseSchema.$defs.report.required.includes('conclusion'));
  assert.equal(requestSchema.properties.consent.properties.policy_id.const, CHECK_DATA_POLICY.policy_id);
  assert.ok(requestSchema.properties.artifacts.items.properties.kind.enum.includes('conversation_export'));

  for (const legacyField of ['terminal', 'html_report', 'source_commit', 'private_report']) {
    assert.ok(!Object.hasOwn(responseSchema.properties, legacyField));
  }
});

test('rejects source names the hosted path grammar cannot represent', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { project } = await makeProject(t, { files: { 'bad:name.js': 'unsafe();\n' } });
  const result = await runCli(['scan', project, '--dry-run']);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /source path cannot be represented by the hosted contract/);
});

test('sanitizes target labels and preflight output against terminal controls', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await temporaryDirectory(t);
  const project = path.join(base, `project\u001b[31m`);
  await mkdir(project);
  await writeFile(path.join(project, 'app.js'), 'safe();\n');
  const result = await runCli(['scan', project, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('\u001b'));
  assert.match(result.stdout, /Target label: "project�\[31m"/);

  const bounded = targetLabelForRoot(path.join('/tmp', '界'.repeat(200)));
  assert.ok(Buffer.byteLength(bounded) <= SERVER_LIMITS.maxTargetBytes);
  assert.ok(bounded.endsWith('...'));
});
