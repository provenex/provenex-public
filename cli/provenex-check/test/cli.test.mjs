import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmod,
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
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  targetLabelForRoot,
} from '../src/collector.mjs';
import {
  CLIENT_LIMITS,
  readBoundedJson,
  submitRun,
  validateApiOrigin,
} from '../src/client.mjs';
import { createExcludeMatcher } from '../src/excludes.mjs';
import { DISCOVERY_LIMITS, SERVER_LIMITS } from '../src/limits.mjs';
import { confirmUpload } from '../src/main.mjs';
import { atomicWrite } from '../src/output.mjs';
import { CHECK_DATA_POLICY } from '../src/policy.mjs';
import { validateHostedResponse } from '../src/report.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'provenex-check.js');
const TEST_TOKEN = 'pvx_test_token_never_print_this';
const TEST_DEV_TOKEN = 'pvx_dev_test_token_never_print_this';
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
        PROVENEX_CHECK_DEV_API_KEY: '',
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
    env: {
      PROVENEX_API_KEY: TEST_TOKEN,
      PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN,
      XDG_CONFIG_HOME: config,
    },
  });

  assert.equal(result.code, 1, result.stderr);
  assert.equal(authorization, `Bearer ${TEST_DEV_TOKEN}`);
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
  assert.ok(!result.stdout.includes(TEST_DEV_TOKEN));
  assert.ok(!result.stderr.includes(TEST_DEV_TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_TOKEN));
});

test('preserves repeated internal spaces and NBSP in the requested and returned target', async (t) => {
  const base = await temporaryDirectory(t);
  const target = 'solo  founder\u00a0project';
  const project = path.join(base, target);
  await mkdir(project);
  await writeFile(path.join(project, 'app.js'), 'export const safe = true;\n');

  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse({ target })));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(captured.target, target);
  assert.equal(targetLabelForRoot(project), target);
  assert.match(result.stdout, /No findings were emitted/);
});

test('repository Git inspection cannot execute a configured fsmonitor command', async (t) => {
  const { base, project } = await makeProject(t);
  const sentinel = path.join(base, 'fsmonitor-executed');
  const fsmonitor = path.join(base, 'malicious-fsmonitor.cjs');
  await writeFile(
    fsmonitor,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\nprocess.stdout.write('builtin:test-token\\n');\n`,
  );
  await chmod(fsmonitor, 0o700);

  assert.equal(spawnSync('git', ['init', '-q', project], { shell: false }).status, 0);
  assert.equal(spawnSync('git', ['-C', project, 'add', 'app.js'], { shell: false }).status, 0);
  assert.equal(
    spawnSync('git', ['-C', project, 'config', '--local', 'core.fsmonitor', fsmonitor], { shell: false }).status,
    0,
  );

  const unprotected = spawnSync(
    'git',
    ['-C', project, 'ls-files', '-z', '--others', '--exclude-standard'],
    { shell: false },
  );
  assert.equal(unprotected.status, 0, unprotected.stderr?.toString('utf8'));
  assert.equal(await readFile(sentinel, 'utf8'), 'executed');
  await rm(sentinel);

  const result = await runCli(['scan', project, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(sentinel), (error) => error?.code === 'ENOENT');
});

test('Git subprocesses never inherit production or development API keys', async (t) => {
  const { base, project } = await makeProject(t);
  const fakeBin = path.join(base, 'fake-bin');
  const git = path.join(fakeBin, 'git');
  const observations = path.join(base, 'git-environment-observations');
  await mkdir(fakeBin);
  await writeFile(
    git,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst observed = { production: process.env.PROVENEX_API_KEY ?? null, development: process.env.PROVENEX_CHECK_DEV_API_KEY ?? null, execPath: process.env.GIT_EXEC_PATH ?? null, parameters: process.env.GIT_CONFIG_PARAMETERS ?? null, count: process.env.GIT_CONFIG_COUNT ?? null, key0: process.env.GIT_CONFIG_KEY_0 ?? null, value0: process.env.GIT_CONFIG_VALUE_0 ?? null, path: process.env.PATH };\nfs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify(observed) + '\\n');\nif (process.argv.includes('rev-parse')) process.stdout.write('true\\n');\nelse if (process.argv.includes('--cached')) process.stdout.write('app.js\\0');\n`,
  );
  await chmod(git, 0o700);

  const result = await runCli(['scan', project, '--dry-run'], {
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      PROVENEX_API_KEY: TEST_TOKEN,
      PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN,
      GIT_EXEC_PATH: path.join(project, 'malicious-git-exec-path'),
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=malicious'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'malicious',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const observed = (await readFile(observations, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(observed.length, 4);
  for (const entry of observed) {
    assert.equal(entry.production, null);
    assert.equal(entry.development, null);
    assert.equal(entry.execPath, null);
    assert.equal(entry.parameters, null);
    assert.equal(entry.count, null);
    assert.equal(entry.key0, null);
    assert.equal(entry.value0, null);
    for (const directory of entry.path.split(path.delimiter)) {
      assert.equal(path.isAbsolute(directory), true);
      const relative = path.relative(project, directory);
      assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`));
      assert.equal(
        path.basename(directory).toLowerCase() === '.bin'
          && path.basename(path.dirname(directory)).toLowerCase() === 'node_modules',
        false,
      );
    }
  }
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_DEV_TOKEN));
});

test('Git resolution skips target and parent-workspace node_modules shims', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  const project = path.join(workspace, 'packages', 'app');
  const targetBin = path.join(project, 'node_modules', '.bin');
  const workspaceBin = path.join(workspace, 'node_modules', '.bin');
  const targetSentinel = path.join(base, 'target-shim-executed');
  const workspaceSentinel = path.join(base, 'workspace-shim-executed');
  await mkdir(targetBin, { recursive: true });
  await mkdir(workspaceBin, { recursive: true });
  await writeFile(path.join(project, 'app.js'), 'export const safe = true;\n');

  for (const [directory, sentinel] of [
    [targetBin, targetSentinel],
    [workspaceBin, workspaceSentinel],
  ]) {
    const shim = path.join(directory, 'git');
    await writeFile(
      shim,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\nprocess.stdout.write('true\\n');\n`,
    );
    await chmod(shim, 0o700);
  }

  assert.equal(spawnSync('git', ['init', '-q', project], { shell: false }).status, 0);
  assert.equal(spawnSync('git', ['-C', project, 'add', 'app.js'], { shell: false }).status, 0);

  const captured = [];
  const origin = await mockServer(t, async (request, response) => {
    captured.push(JSON.parse(await readRequest(request)));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse({ target: 'app' })));
  });
  const safeFallback = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: {
      PATH: `${targetBin}${path.delimiter}${workspaceBin}${path.delimiter}${process.env.PATH}`,
      PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN,
    },
  });
  assert.equal(safeFallback.code, 0, safeFallback.stderr);
  assert.equal(captured[0].source_files.find((file) => file.relative_path === 'app.js').git_state, 'tracked');

  const unknownFallback = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: {
      PATH: `${targetBin}${path.delimiter}${workspaceBin}`,
      PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN,
    },
  });
  assert.equal(unknownFallback.code, 0, unknownFallback.stderr);
  assert.equal(captured[1].source_files.find((file) => file.relative_path === 'app.js').git_state, 'unknown');
  await assert.rejects(readFile(targetSentinel), (error) => error?.code === 'ENOENT');
  await assert.rejects(readFile(workspaceSentinel), (error) => error?.code === 'ENOENT');
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

test('missing production key gives honest alpha trial instructions and remains a local usage error', async (t) => {
  const { project, config } = await makeProject(t);
  const result = await runCli(['scan', project, '--yes'], {
    env: { XDG_CONFIG_HOME: config },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /obtain a Check API key from your Provenex trial administrator/);
  assert.match(result.stderr, /self-serve signup is not available in alpha/);
});

test('loopback uses only its dev key and ignores production environment and config credentials', async (t) => {
  const { project, config } = await makeProject(t);
  const productionConfigDirectory = path.join(config, 'provenex');
  const productionConfig = path.join(productionConfigDirectory, 'check.json');
  await mkdir(productionConfigDirectory);
  await writeFile(productionConfig, JSON.stringify({ api_key: 'production-config-token' }));
  await chmod(productionConfig, 0o600);

  let requests = 0;
  const origin = await mockServer(t, (_request, response) => {
    requests += 1;
    response.end();
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_API_KEY: TEST_TOKEN, XDG_CONFIG_HOME: config },
  });
  assert.equal(result.code, 2);
  assert.equal(requests, 0);
  assert.match(result.stdout, /Endpoint class: non-production loopback development endpoint/);
  assert.match(result.stdout, /Do not submit real sensitive evidence or a production API key/);
  assert.doesNotMatch(result.stdout, /uploads the approved evidence to Provenex's central multi-tenant/);
  assert.match(result.stderr, /set PROVENEX_CHECK_DEV_API_KEY/);
  assert.match(result.stderr, /never read PROVENEX_API_KEY or the production API key config/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('production-config-token'));
});

test('home-directory and ancestor scan roots are refused while project descendants remain eligible', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await temporaryDirectory(t);
  const fakeHome = path.join(base, 'home');
  const project = path.join(fakeHome, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'app.js'), 'export const safe = true;\n');

  for (const refused of [fakeHome, base]) {
    const result = await runCli(['scan', refused, '--dry-run'], { env: { HOME: fakeHome } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /home directory or one of its ancestors/);
  }
  const allowed = await runCli(['scan', project, '--dry-run'], { env: { HOME: fakeHome } });
  assert.equal(allowed.code, 0, allowed.stderr);
});

test('owner credential config is excluded for custom and canonicalized XDG paths', {
  skip: process.platform === 'win32',
}, async (t) => {
  for (const mode of ['custom-xdg', 'symlinked-xdg']) {
    const base = await temporaryDirectory(t);
    const project = path.join(base, `credential-store-${mode}`);
    const fakeHome = path.join(base, 'home');
    const actualConfigBase = path.join(project, 'actual-config');
    const configDirectory = path.join(actualConfigBase, 'provenex');
    const configFile = path.join(configDirectory, 'check.json');
    const configSecret = `owner-config-secret-${mode}`;
    await mkdir(configDirectory, { recursive: true });
    await mkdir(fakeHome);
    await writeFile(path.join(project, 'app.js'), 'export const safe = true;\n');
    await writeFile(configFile, JSON.stringify({ api_key: configSecret }));
    await chmod(configFile, 0o600);

    let xdgConfigHome = actualConfigBase;
    if (mode === 'symlinked-xdg') {
      xdgConfigHome = path.join(base, 'config-link');
      await symlink(actualConfigBase, xdgConfigHome);
    }

    let captured;
    const origin = await mockServer(t, async (request, response) => {
      captured = JSON.parse(await readRequest(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(validResponse({ target: path.basename(project) })));
    });
    const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
      env: {
        HOME: fakeHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN,
      },
    });

    assert.equal(result.code, 0, `${mode}: ${result.stderr}`);
    assert.ok(!captured.source_files.some((file) => file.relative_path.endsWith('provenex/check.json')));
    assert.ok(!JSON.stringify(captured).includes(configSecret));
    assert.match(result.stdout, /Always-on local-auth exclusions/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(configFile));

    const explicitConfigFile = path.join(xdgConfigHome, 'provenex', 'check.json');
    const explicit = await runCli([
      'scan', project, '--dependency-audit', explicitConfigFile, '--dry-run',
    ], {
      env: { HOME: fakeHome, XDG_CONFIG_HOME: xdgConfigHome },
    });
    assert.equal(explicit.code, 3);
    assert.match(explicit.stderr, /protected local credential store cannot be selected/);
    assert.ok(!`${explicit.stdout}${explicit.stderr}`.includes(explicitConfigFile));
    assert.ok(!`${explicit.stdout}${explicit.stderr}`.includes(configSecret));
  }
});

test('known AI-history roots and descendants cannot become generic scan roots', async (t) => {
  const base = await temporaryDirectory(t);
  const fakeHome = path.join(base, 'home');
  const codexSessions = path.join(fakeHome, '.codex', 'sessions');
  const claudeProjects = path.join(fakeHome, '.claude', 'projects');
  const codexDescendant = path.join(codexSessions, '2026', '08');
  await mkdir(codexDescendant, { recursive: true });
  await mkdir(claudeProjects, { recursive: true });
  await writeFile(path.join(codexDescendant, 'session.json'), '{"sensitive":true}\n');
  const explicitSession = path.join(codexDescendant, 'explicit-session.jsonl');
  await writeFile(explicitSession, '{"type":"assistant","message":"supported"}\n');
  await writeFile(path.join(claudeProjects, 'history.json'), '{"sensitive":true}\n');

  for (const candidate of [codexSessions, codexDescendant, claudeProjects]) {
    const result = await runCli(['scan', candidate, '--dry-run'], { env: { HOME: fakeHome } });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /refusing to scan a protected AI-history directory/);
  }

  const project = path.join(base, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'app.js'), 'export const safe = true;\n');
  const mislabeled = await runCli([
    'scan', project, '--dependency-audit', explicitSession, '--dry-run',
  ], { env: { HOME: fakeHome } });
  assert.equal(mislabeled.code, 3);
  assert.match(mislabeled.stderr, /require explicit --session-input consent/);
  assert.ok(!`${mislabeled.stdout}${mislabeled.stderr}`.includes(explicitSession));

  const consented = await runCli([
    'scan', project, '--session-input', explicitSession, '--dry-run',
  ], { env: { HOME: fakeHome } });
  assert.equal(consented.code, 0, consented.stderr);
  assert.match(consented.stdout, /High-sensitivity categories: ai_session_history/);
  assert.match(consented.stdout, /session: .*explicit-session\.jsonl/);
});

test('known Codex auth store cannot be swept or explicitly selected', async (t) => {
  const { base, project } = await makeProject(t);
  const fakeHome = path.join(base, 'home');
  const authDirectory = path.join(fakeHome, '.codex');
  const authFile = path.join(authDirectory, 'auth.json');
  const authSecret = 'codex-auth-secret-must-not-leave';
  await mkdir(authDirectory, { recursive: true });
  await writeFile(authFile, JSON.stringify({ token: authSecret }));

  const result = await runCli([
    'scan', project, '--dependency-audit', authFile, '--dry-run',
  ], { env: { HOME: fakeHome } });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /protected local credential store cannot be selected/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(authFile));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(authSecret));
});

test('active bearer in selected evidence fails closed before a request', async (t) => {
  const exactKey = 'pvx_dev_active_bearer_in_source';
  const exact = await makeProject(t, {
    files: {
      'app.js': 'export const safe = true;\n',
      '.env': `ACTIVE_TOKEN=${exactKey}\n`,
    },
  });
  let exactRequests = 0;
  const exactOrigin = await mockServer(t, (_request, response) => {
    exactRequests += 1;
    response.end();
  });

  const dryRun = await runCli(['scan', exact.project, '--dry-run'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: exactKey },
  });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /no API key was read/);

  const exactResult = await runCli(['scan', exact.project, '--api-url', exactOrigin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: exactKey },
  });
  assert.equal(exactResult.code, 3);
  assert.equal(exactRequests, 0);
  assert.match(exactResult.stderr, /selected evidence contains the active API credential/);
  assert.ok(!`${exactResult.stdout}${exactResult.stderr}`.includes(exactKey));

  const escapedKey = 'pvx_dev_"escaped\\bearer';
  const escaped = await makeProject(t);
  const session = path.join(escaped.base, 'session.jsonl');
  const serializedSession = `${JSON.stringify({ message: escapedKey })}\n`;
  assert.equal(serializedSession.includes(escapedKey), false);
  await writeFile(session, serializedSession);
  let escapedRequests = 0;
  const escapedOrigin = await mockServer(t, (_request, response) => {
    escapedRequests += 1;
    response.end();
  });
  const escapedResult = await runCli([
    'scan', escaped.project,
    '--session-input', session,
    '--api-url', escapedOrigin,
    '--yes',
  ], { env: { PROVENEX_CHECK_DEV_API_KEY: escapedKey } });
  assert.equal(escapedResult.code, 3);
  assert.equal(escapedRequests, 0);
  assert.match(escapedResult.stderr, /selected evidence contains the active API credential/);
  assert.ok(!`${escapedResult.stdout}${escapedResult.stderr}`.includes(escapedKey));
});

test('pins remote API access and permits only loopback development overrides', async (t) => {
  const { project } = await makeProject(t);
  for (const candidate of [
    { args: ['--api-url', 'http://example.com'], env: {} },
    { args: ['--api-url', 'https://example.com'], env: {} },
    { args: [], env: { PROVENEX_CHECK_API_URL: 'https://example.com' } },
  ]) {
    const result = await runCli(['scan', project, ...candidate.args, '--yes'], {
      env: { PROVENEX_API_KEY: TEST_TOKEN, ...candidate.env },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /must be https:\/\/api\.provenex\.ai/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_TOKEN));
  }

  const loopbackHttps = await runCli([
    'scan', project, '--api-url', 'https://localhost:4443', '--dry-run',
  ]);
  assert.equal(loopbackHttps.code, 0, loopbackHttps.stderr);
  assert.match(loopbackHttps.stdout, /API origin: https:\/\/localhost:4443/);
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

  for (const [command, flag, kind] of [
    ['audit', '--aws-input', 'aws_cost'],
    ['scan', '--dependency-audit', 'dependency_audit'],
  ]) {
    const overKindCap = await runCli([
      command,
      project,
      ...Array.from({ length: 33 }, () => [flag, path.join(base, 'does-not-need-to-exist.json')]).flat(),
      '--dry-run',
    ]);
    assert.equal(overKindCap.code, 3);
    assert.match(overKindCap.stderr, new RegExp(`${kind} artifact selection contains 33 files; limit is 32`));
  }
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
    response.end(`server accidentally echoed ${TEST_DEV_TOKEN}`);
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /HTTP 500 \(request safe-request-id\)/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_DEV_TOKEN));
  assert.ok(!result.stderr.includes('server accidentally'));
});

test('rejects legacy server-rendered and private response fields', async (t) => {
  const { project } = await makeProject(t);
  const legacy = {
    ...validResponse(),
    terminal: '\u001b[31mMALICIOUS_SERVER_TERMINAL',
    html_report: '<script>malicious()</script>',
    source_commit: 'a'.repeat(40),
  };
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(legacy));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /response has unsupported fields/);
  assert.ok(!result.stdout.includes('MALICIOUS_SERVER_TERMINAL'));
  assert.ok(!result.stdout.includes('\u001b'));
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
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
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
      env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
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
      env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
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
  ], { env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN } });
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
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
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
    env: { HOME: fakeHome, PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
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

test('broad source scans never sweep conversations.json as configuration', async (t) => {
  const conversationMarker = 'conversation-history-must-require-explicit-consent';
  const { project } = await makeProject(t, {
    files: {
      'app.js': 'export const safe = true;\n',
      'exports/conversations.json': '[{"message":"conversation-history-must-require-explicit-consent"}]\n',
      'exports/Conversations.JSON': '[{"message":"mixed-case-history"}]\n',
      'exports/CONVERSATIONS.json': '[{"message":"upper-case-history"}]\n',
    },
  });
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(captured.source_files.map((file) => file.relative_path), ['app.js']);
  assert.equal(captured.artifacts.length, 0);
  assert.ok(!captured.consent.categories.includes('ai_session_history'));
  assert.ok(!JSON.stringify(captured).includes(conversationMarker));
  assert.ok(!JSON.stringify(captured).includes('mixed-case-history'));
  assert.ok(!JSON.stringify(captured).includes('upper-case-history'));
  assert.match(result.stdout, /conversations\.json is never swept as/);
  assert.match(result.stdout, /select it explicitly with --session-input/);
});

test('routes an exact supported web conversations.json export without exposing its basename', async (t) => {
  const { project } = await makeProject(t);
  const exportDirectory = path.join(project, 'chatgpt-export');
  await mkdir(exportDirectory);
  const conversationExport = path.join(exportDirectory, 'conversations.json');
  await writeFile(conversationExport, '[{"id":"conversation","mapping":{}}]\n');
  const mislabeled = await runCli([
    'scan', project, '--dependency-audit', conversationExport, '--dry-run',
  ]);
  assert.equal(mislabeled.code, 3);
  assert.match(mislabeled.stderr, /web conversation exports require explicit --session-input consent/);
  assert.ok(!`${mislabeled.stdout}${mislabeled.stderr}`.includes(conversationExport));

  const mixedCaseExport = path.join(exportDirectory, 'Conversations.JSON');
  await writeFile(mixedCaseExport, '[{"id":"mixed-case-conversation","mapping":{}}]\n');
  const mixedCaseMislabeled = await runCli([
    'scan', project, '--dependency-audit', mixedCaseExport, '--dry-run',
  ]);
  assert.equal(mixedCaseMislabeled.code, 3);
  assert.match(mixedCaseMislabeled.stderr, /web conversation exports require explicit --session-input consent/);
  assert.ok(!`${mixedCaseMislabeled.stdout}${mixedCaseMislabeled.stderr}`.includes(mixedCaseExport));

  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli([
    'scan', project, '--session-input', conversationExport, '--api-url', origin, '--yes',
  ], { env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(captured.artifacts.map(({ kind, name }) => ({ kind, name })), [{
    kind: 'conversation_export',
    name: 'conversation-export-001.json',
  }]);
  assert.ok(!captured.artifacts[0].name.includes('conversations'));
  assert.ok(!captured.source_files.some((file) => file.relative_path.endsWith('conversations.json')));
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
  ], { env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN } });

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
    'settings.json': '{"feature":true}\n',
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
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  const selected = new Set(captured.source_files.map((file) => file.relative_path));
  for (const filename of Object.keys(representative)) {
    assert.ok(selected.has(filename), `expected ${filename} to be collected`);
  }
  assert.ok(captured.consent.categories.includes('environment_secrets'));
  assert.ok(captured.consent.categories.includes('configuration'));
  assert.match(result.stdout, /High-sensitivity categories: .*configuration/);
  assert.match(result.stdout, /High-sensitivity source paths selected/);
  assert.match(result.stdout, /\.npmrc/);
  assert.match(result.stdout, /\.envrc/);
});

test('hosted request limits and path grammar stay aligned with the public schema', async () => {
  const schema = JSON.parse(await readFile(
    path.join(PACKAGE_ROOT, 'schemas', 'provenex-check-request.v1.schema.json'),
    'utf8',
  ));
  assert.equal(
    schema.properties.consent.properties.categories.maxItems,
    SERVER_LIMITS.maxConsentCategories,
  );
  assert.equal(schema.properties.source_files.maxItems, SERVER_LIMITS.maxSourceFiles);
  assert.equal(schema.properties.artifacts.maxItems, SERVER_LIMITS.maxArtifacts);
  assert.equal(SERVER_LIMITS.maxArtifacts, 256);
  assert.equal(SERVER_LIMITS.maxConsentCategories, 8);
  assert.equal(SERVER_LIMITS.maxAwsCostArtifacts, 32);
  assert.equal(SERVER_LIMITS.maxDependencyAuditArtifacts, 32);
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
  assert.deepEqual(
    schema.allOf[0].if,
    {
      properties: { command: { const: 'scan' } },
      required: ['command'],
    },
  );
  assert.deepEqual(
    schema.allOf[0].then.properties.artifacts.items.properties.kind.enum,
    ['session', 'conversation_export', 'dependency_audit'],
  );
  assert.deepEqual(
    schema.allOf.slice(1).map((rule) => ({
      kind: rule.properties.artifacts.contains.properties.kind.const,
      min: rule.properties.artifacts.minContains,
      max: rule.properties.artifacts.maxContains,
    })),
    [
      { kind: 'aws_cost', min: 0, max: SERVER_LIMITS.maxAwsCostArtifacts },
      { kind: 'dependency_audit', min: 0, max: SERVER_LIMITS.maxDependencyAuditArtifacts },
    ],
  );
  assert.deepEqual(
    schema.properties.artifacts.items.properties.kind.enum,
    ['session', 'conversation_export', 'fly_log', 'cloudwatch_log', 'aws_cost', 'dependency_audit'],
  );
  const artifactNamePatterns = Object.fromEntries(
    schema.properties.artifacts.items.allOf.map((rule) => [
      rule.if.properties.kind.const,
      rule.then.properties.name.pattern,
    ]),
  );
  const artifactNameExamples = {
    session: 'session-001.jsonl',
    conversation_export: 'conversation-export-001.json',
    fly_log: 'fly-log-001.jsonl',
    cloudwatch_log: 'cloudwatch-log-001.json',
    aws_cost: 'aws-cost-001.json',
    dependency_audit: 'dependency-audit-001.json',
  };
  assert.deepEqual(Object.keys(artifactNamePatterns).sort(), Object.keys(artifactNameExamples).sort());
  for (const [kind, validName] of Object.entries(artifactNameExamples)) {
    const pattern = new RegExp(artifactNamePatterns[kind], 'u');
    assert.equal(pattern.test(validName), true, `${kind} must accept ${validName}`);
    for (const [otherKind, otherName] of Object.entries(artifactNameExamples)) {
      if (otherKind !== kind) assert.equal(pattern.test(otherName), false, `${kind} must reject ${otherName}`);
    }
  }
  assert.deepEqual(DISCOVERY_LIMITS, {
    maxCandidateFiles: 20_000,
    maxDirectoryEntries: 100_000,
    maxDirectories: 10_000,
    maxMetadataBytes: 32 * 1024 * 1024,
    maxFirstRecordBytes: 64 * 1024,
  });
  assert.deepEqual(CLIENT_LIMITS, {
    maxResponseBytes: 32 * 1024 * 1024,
    uploadAndHeadersTotalMs: 30 * 60 * 1000,
    responseBodyIdleMs: 60 * 1000,
    responseBodyTotalMs: 10 * 60 * 1000,
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

  const targetPattern = new RegExp(schema.properties.target.pattern, 'u');
  assert.equal(targetPattern.test('solo  founder\u00a0project'), true);
  assert.equal(targetPattern.test(' leading-space'), false);
  assert.equal(targetPattern.test('trailing-space '), false);
  for (const unsafe of ['project\u0085name', 'project\u200dname', 'project\u2028name', 'project\u2029name']) {
    assert.equal(targetPattern.test(unsafe), false, `target pattern must reject ${JSON.stringify(unsafe)}`);
  }
});

test('OpenAPI documents the complete hosted error surface', async () => {
  const openapi = await readFile(
    path.join(PACKAGE_ROOT, 'openapi', 'provenex-check.v1.yaml'),
    'utf8',
  );
  for (const status of ['400', '401', '402', '403', '413', '415', '422', '429', '500']) {
    assert.match(openapi, new RegExp(`^        '${status}':`, 'm'));
  }
  assert.match(openapi, /runtime logs and cost evidence require\n          audit/);
  assert.match(openapi, /x-maxResponseBytes: 33554432/);
  assert.match(openapi, /uploadAndHeadersTotalMs: 1800000/);
  assert.match(openapi, /responseBodyIdleMs: 60000/);
  assert.match(openapi, /responseBodyTotalMs: 600000/);

  const readme = await readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /Discovery fails closed rather than/);
  assert.doesNotMatch(readme, /Discovery stops at/);
  assert.match(readme, /--exclude '\*\.env'/);
});

test('npm manifest is intentionally private and has no publication configuration', async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(Object.hasOwn(manifest, 'publishConfig'), false);
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
  assert.equal(responseSchema['x-maxSerializedResponseBytes'], CLIENT_LIMITS.maxResponseBytes);
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

  const displayProperties = [
    responseSchema.$defs.finding.properties.title,
    responseSchema.$defs.finding.properties.consequence,
    responseSchema.$defs.finding.properties.evidence,
    responseSchema.$defs.finding.properties.next_step,
    responseSchema.$defs.coverage.properties.detail,
    responseSchema.$defs.report.properties.conclusion,
    responseSchema.$defs.report.properties.limitations.items,
  ];
  for (const property of displayProperties) {
    const pattern = new RegExp(property.pattern, 'u');
    assert.equal(pattern.test('Safe customer-facing text.'), true);
    assert.equal(pattern.test('   '), false);
    assert.equal(pattern.test('unsafe\u001b[31m'), false);
    assert.equal(pattern.test('unsafe\u200dformat'), false);
  }
  const responseTargetPattern = new RegExp(
    responseSchema.$defs.report.properties.target.pattern,
    'u',
  );
  assert.equal(responseTargetPattern.test('solo  founder\u00a0project'), true);
  assert.equal(responseTargetPattern.test(' leading'), false);
  assert.equal(responseTargetPattern.test('trailing '), false);
  assert.equal(responseTargetPattern.test('unsafe\u001btarget'), false);

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

test('interactive upload consent accepts only an explicit yes on TTY streams', async () => {
  async function answer(value) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    let displayed = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => { displayed += chunk; });
    const pending = confirmUpload('http://127.0.0.1:8787', { input, output });
    input.end(value + '\n');
    return { approved: await pending, displayed };
  }

  const accepted = await answer('  YeS  ');
  assert.equal(accepted.approved, true);
  assert.match(accepted.displayed, /Type yes to continue/);
  assert.match(accepted.displayed, /http:\/\/127\.0\.0\.1:8787/);
  assert.equal((await answer('y')).approved, false);
  assert.equal((await answer('no')).approved, false);
  await assert.rejects(
    confirmUpload('https://api.provenex.ai', {
      input: new PassThrough(),
      output: new PassThrough(),
    }),
    /interactive approval or explicit --yes/,
  );
});

test('API origin validation handles normalized origins and rejects endpoint edge cases', () => {
  const accepted = new Map([
    ['https://api.provenex.ai', 'https://api.provenex.ai'],
    ['https://api.provenex.ai:443/', 'https://api.provenex.ai'],
    ['HTTPS://API.PROVENEX.AI', 'https://api.provenex.ai'],
    ['http://localhost:8787/', 'http://localhost:8787'],
    ['https://127.0.0.1:4443', 'https://127.0.0.1:4443'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ]);
  for (const [candidate, normalized] of accepted) {
    assert.equal(validateApiOrigin(candidate), normalized);
  }

  for (const candidate of [
    'https://api.provenex.ai:4443',
    'http://api.provenex.ai',
    'https://user@api.provenex.ai',
    'https://api.provenex.ai/v1',
    'https://api.provenex.ai?tenant=x',
    'https://api.provenex.ai#fragment',
    'http://127.0.0.2:8787',
    'https://localhost.example:8787',
    'file://localhost/tmp',
    '//api.provenex.ai',
    'not a URL',
  ]) {
    assert.throws(() => validateApiOrigin(candidate), /API URL/);
  }
});

test('dry-run performs no network request even when a loopback endpoint and --yes are supplied', async (t) => {
  const { project } = await makeProject(t);
  let requests = 0;
  const origin = await mockServer(t, (_request, response) => {
    requests += 1;
    response.end();
  });
  const result = await runCli([
    'audit', project, '--api-url', origin, '--yes', '--dry-run',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, 0);
  assert.match(result.stdout, /nothing was uploaded and no API key was read/);
});

test('transport bounds upload headers and streamed response idle and total time', async () => {
  const base = {
    origin: 'http://127.0.0.1:8787',
    apiKey: TEST_DEV_TOKEN,
    serializedRequest: '{}',
    expected: { command: 'scan', target: 'sample-project' },
  };

  let uploadSignal;
  await assert.rejects(
    submitRun({
      ...base,
      fetchImpl: (_url, options) => {
        uploadSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      limits: { uploadAndHeadersTotalMs: 25 },
    }),
    /upload and response headers total timeout expired/,
  );
  assert.equal(uploadSignal.aborted, true);

  let idleCanceled = false;
  await assert.rejects(
    submitRun({
      ...base,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { idleCanceled = true; },
      }), { status: 200 }),
      limits: { responseBodyIdleMs: 25, responseBodyTotalMs: 1000 },
    }),
    /response body idle timeout expired/,
  );
  assert.equal(idleCanceled, true);

  const encoder = new TextEncoder();
  let totalCanceled = false;
  let totalInterval;
  await assert.rejects(
    submitRun({
      ...base,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          totalInterval = setInterval(() => controller.enqueue(encoder.encode(' ')), 5);
        },
        cancel() {
          clearInterval(totalInterval);
          totalCanceled = true;
        },
      }), { status: 200 }),
      limits: { responseBodyIdleMs: 200, responseBodyTotalMs: 50 },
    }),
    /response body total timeout expired/,
  );
  assert.equal(totalCanceled, true);
});

test('streamed responses without content-length are still byte bounded', async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
      controller.enqueue(Uint8Array.from([5, 6, 7, 8, 9]));
      controller.close();
    },
  }), { status: 200 });
  assert.equal(response.headers.has('content-length'), false);
  await assert.rejects(
    readBoundedJson(response, { maxBytes: 8, idleTimeoutMs: 1000, totalTimeoutMs: 1000 }),
    /response exceeds 8 bytes/,
  );
});

test('server-authored terminal controls are rejected before local rendering', () => {
  for (const finding of [
    publicFinding({ title: 'unsafe\u001b[31mterminal' }),
    publicFinding({ evidence: 'unsafe\u200dformat control' }),
  ]) {
    assert.throws(
      () => validateHostedResponse(
        validResponse({ findings: [finding] }),
        { command: 'scan', target: 'sample-project' },
      ),
      /not sanitized display text/,
    );
  }
});

test('hosted reports are bound to both the approved command and target', () => {
  assert.throws(
    () => validateHostedResponse(
      validResponse({ command: 'audit' }),
      { command: 'scan', target: 'sample-project' },
    ),
    /report command differs from the approved request/,
  );
  assert.throws(
    () => validateHostedResponse(
      validResponse({ target: 'different-project' }),
      { command: 'scan', target: 'sample-project' },
    ),
    /report target differs from the approved request/,
  );
});

test('default excluded directories are all pruned before source collection', async (t) => {
  const files = { 'app.js': 'safe();\n' };
  DEFAULT_EXCLUDED_DIRECTORIES.forEach((directory, index) => {
    files[path.posix.join(directory, 'excluded-' + index + '.js')] = 'default-exclusion-marker-' + index + '\n';
  });
  const { project } = await makeProject(t, { files });
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(captured.source_files.map((file) => file.relative_path), ['app.js']);
  assert.ok(!JSON.stringify(captured).includes('default-exclusion-marker'));
  for (const directory of DEFAULT_EXCLUDED_DIRECTORIES) {
    assert.ok(result.stdout.includes(directory), directory);
  }
});

test('exclude matcher covers literal, slash, star, question, and doublestar branches', () => {
  const excluded = createExcludeMatcher([
    'private',
    'fixtures/customer',
    '*.pem',
    'secret?.json',
    'generated/**',
    'src/**/fixture?.ts',
    'logs/*.json',
    'scratch/',
  ]);
  for (const candidate of [
    'private',
    'src/private/key.txt',
    'fixtures/customer',
    'fixtures/customer/record.json',
    'keys/signing.pem',
    'nested/secret1.json',
    'generated',
    'generated/deep/output.js',
    'src/fixture1.ts',
    'src/a/b/fixture2.ts',
    'logs/current.json',
    'nested/scratch/file.js',
  ]) {
    assert.equal(excluded(candidate), true, candidate);
  }
  for (const candidate of [
    'privately/file.js',
    'fixtures/customers/record.json',
    'keys/signing.pem.bak',
    'secret12.json',
    'generated-neighbor/file.js',
    'src/a/fixture12.ts',
    'logs/deep/current.json',
    'scratchpad/file.js',
  ]) {
    assert.equal(excluded(candidate), false, candidate);
  }
});

test('every env suffix is selected as high-sensitivity environment evidence', async (t) => {
  const { project } = await makeProject(t, {
    files: {
      'app.js': 'safe();\n',
      'prod.env': 'TOKEN=example\n',
      'config/staging.ENV': 'TOKEN=example\n',
    },
  });
  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse()));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(captured.consent.categories.includes('environment_secrets'));
  assert.ok(!captured.consent.categories.includes('configuration'));
  assert.match(result.stdout, /High-sensitivity source paths selected: .*prod\.env/);
  assert.match(result.stdout, /config\/staging\.ENV/);
});

test('audit sends every supported artifact with only opaque deterministic metadata', async (t) => {
  const { base, project } = await makeProject(t);
  const inputs = {
    session: path.join(base, 'customer-session-name.jsonl'),
    conversation: path.join(base, 'web-export', 'conversations.json'),
    fly: path.join(base, 'production-fly-log.txt'),
    cloudwatch: path.join(base, 'production-cloudwatch-log.txt'),
    aws: path.join(base, 'sensitive-cost-export.csv'),
    dependency: path.join(base, 'private-dependency-report.txt'),
  };
  await mkdir(path.dirname(inputs.conversation), { recursive: true });
  await writeFile(inputs.session, '{"type":"assistant"}\n');
  await writeFile(inputs.conversation, '[{"mapping":{}}]\n');
  await writeFile(inputs.fly, '{"message":"fly"}\n');
  await writeFile(inputs.cloudwatch, '{"events":[]}\n');
  await writeFile(inputs.aws, '{"total":1}\n');
  await writeFile(inputs.dependency, '{"vulnerabilities":{}}\n');

  let captured;
  const origin = await mockServer(t, async (request, response) => {
    captured = JSON.parse(await readRequest(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse({ command: 'audit' })));
  });
  const result = await runCli([
    'audit', project,
    '--session-input', inputs.session,
    '--session-input', inputs.conversation,
    '--fly-log', inputs.fly,
    '--cloudwatch-log', inputs.cloudwatch,
    '--aws-input', inputs.aws,
    '--dependency-audit', inputs.dependency,
    '--api-url', origin,
    '--yes',
  ], { env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(captured.command, 'audit');
  assert.deepEqual(captured.artifacts.map(({ kind, name }) => ({ kind, name })), [
    { kind: 'session', name: 'session-001.jsonl' },
    { kind: 'conversation_export', name: 'conversation-export-001.json' },
    { kind: 'fly_log', name: 'fly-log-001.jsonl' },
    { kind: 'cloudwatch_log', name: 'cloudwatch-log-001.json' },
    { kind: 'aws_cost', name: 'aws-cost-001.json' },
    { kind: 'dependency_audit', name: 'dependency-audit-001.json' },
  ]);
  for (const artifact of captured.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ['content', 'kind', 'name']);
  }
  for (const localPath of Object.values(inputs)) {
    assert.ok(!JSON.stringify(captured.artifacts).includes(path.basename(localPath)));
  }
});

test('an incomplete hosted analysis preserves the public exit code 3', async (t) => {
  const { project } = await makeProject(t);
  const origin = await mockServer(t, async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(validResponse({
      status: 'incomplete',
      coverage: [{
        id: 'coverage-0001',
        category: 'application_security',
        status: 'partial',
        detail: 'Only part of the selected evidence could be evaluated.',
      }],
      limitations: ['Analysis stopped safely before all checks completed.'],
    })));
  });
  const result = await runCli(['scan', project, '--api-url', origin, '--yes'], {
    env: { PROVENEX_CHECK_DEV_API_KEY: TEST_DEV_TOKEN },
  });
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /Provenex Check scan — INCOMPLETE/);
  assert.match(result.stdout, /Only part of the selected evidence could be evaluated/);
});
