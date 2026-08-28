import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCoverage, validateGatewayOrigin } from '../src/coverage.mjs';
import { parseArgs } from '../src/args.mjs';
import { UsageError } from '../src/errors.mjs';

const KEY_ENV = { PROVENEX_SDK_KEY: 'pvx_sdk_test_workload_key' };

function payload() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-26T12:00:00Z',
    workspaceId: 'ws',
    honesty:
      "This reports what this workspace's gateway can prove right now. " +
      'Connected is credentials; it is not coverage. Absent areas are not evaluated, never safe.',
    areas: [
      {
        area: 'decision-lane',
        state: 'covered',
        evidence: 'This workload key is registered prevent / fail-closed on boundary financial-commitment-alpha.',
      },
      {
        area: 'action-custody',
        state: 'partial',
        evidence: 'Custody rows by state: failed=1, succeeded=3. Failed rows are dead-lettered actions awaiting an operator; they never silently release.',
        counts: { failed: 1, succeeded: 3 },
        oldestUnsettledEnqueuedAt: '2026-08-26T10:00:00Z',
      },
      { area: 'connectors', state: 'not-connected', evidence: 'No provider connection is configured for this workspace.' },
    ],
  };
}

function jsonFetch(body, status = 200, capture = {}) {
  return async (input, init) => {
    Object.assign(capture, { input: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('renders the gateway coverage verbatim with the honesty line last', async () => {
  const capture = {};
  const out = await renderCoverage('https://app-sandbox.provenex.ai', {
    env: KEY_ENV,
    fetchImpl: jsonFetch(payload(), 200, capture),
  });
  assert.equal(capture.input, 'https://app-sandbox.provenex.ai/api/sdk/v1/coverage');
  assert.equal(capture.init.headers.authorization, 'Bearer pvx_sdk_test_workload_key');
  assert.match(out, /decision-lane: covered/);
  assert.match(out, /action-custody: PARTIAL/);
  assert.match(out, /custody: failed=1 · succeeded=3/);
  assert.match(out, /oldest unsettled action enqueued at 2026-08-26T10:00:00Z/);
  assert.match(out, /connectors: NOT CONNECTED/);
  assert.match(out, /never safe\.\n$/);
});

test('the key comes only from the environment and is validated', async () => {
  await assert.rejects(
    renderCoverage('https://app-sandbox.provenex.ai', { env: {}, fetchImpl: jsonFetch(payload()) }),
    /PROVENEX_SDK_KEY/,
  );
  await assert.rejects(
    renderCoverage('https://app-sandbox.provenex.ai', {
      env: { PROVENEX_SDK_KEY: 'pvx_trial_nope' },
      fetchImpl: jsonFetch(payload()),
    }),
    UsageError,
  );
});

test('gateway refusals and bad schemas surface as errors, never as coverage', async () => {
  await assert.rejects(
    renderCoverage('https://app-sandbox.provenex.ai', {
      env: KEY_ENV,
      fetchImpl: jsonFetch({ error: 'this workload key cannot read coverage' }, 401),
    }),
    /HTTP 401/,
  );
  await assert.rejects(
    renderCoverage('https://app-sandbox.provenex.ai', {
      env: KEY_ENV,
      fetchImpl: jsonFetch({ schemaVersion: 2, areas: [] }),
    }),
    /unsupported coverage schema/,
  );
});

test('gateway origins follow the checkpoint rules', () => {
  assert.ok(validateGatewayOrigin('https://app-sandbox.provenex.ai'));
  assert.ok(validateGatewayOrigin('http://127.0.0.1:8787'));
  for (const bad of [
    'not a url',
    'http://app-sandbox.provenex.ai',
    'https://api.provenex.ai',
    'https://api.provenex.ai:444',
    'https://api.provenex.ai.:444',
    'https://provenex-verdict.fly.dev',
    'https://provenex-verdict.fly.dev:444',
    'https://app-sandbox.provenex.ai/api',
    'https://user:pw@app-sandbox.provenex.ai',
  ]) {
    assert.throws(() => validateGatewayOrigin(bad), UsageError);
  }
});

test('coverage argument rules: --gateway-url required, nothing else allowed', () => {
  const options = parseArgs(['coverage', '--gateway-url', 'https://app-sandbox.provenex.ai'], {});
  assert.equal(options.command, 'coverage');
  assert.equal(options.gatewayUrl, 'https://app-sandbox.provenex.ai');
  assert.throws(() => parseArgs(['coverage'], {}), /requires --gateway-url/);
  assert.equal(
    parseArgs(['coverage'], { PROVENEX_APP_GATEWAY_URL: 'https://saved.example' }).gatewayUrl,
    'https://saved.example',
  );
  assert.throws(() => parseArgs(['coverage', '.', '--gateway-url', 'https://x.example']), UsageError);
  assert.throws(
    () => parseArgs(['coverage', '--gateway-url', 'https://x.example', '--json', 'out.json']),
    UsageError,
  );
  assert.throws(() => parseArgs(['scan', '.', '--gateway-url', 'https://x.example']), UsageError);
});
