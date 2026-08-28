import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/args.mjs';
import { APP_MAX_RESPONSE_BYTES, fetchAppJson } from '../src/app-client.mjs';
import { renderBrief, validateBrief } from '../src/brief.mjs';
import { UsageError } from '../src/errors.mjs';

const KEY_ENV = { PROVENEX_SDK_KEY: 'pvx_sdk_test_workload_key' };

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-28T14:00:00Z',
    workspaceId: 'brightcart',
    status: 'needs-attention',
    headline: '1 thing needs your attention',
    health: [
      {
        id: 'action-protection',
        label: 'Action protection',
        state: 'working',
        summary: 'Selected actions have a configured checkpoint and signed receipts.',
      },
      {
        id: 'action-outcomes',
        label: 'Action outcomes',
        state: 'needs-attention',
        summary: '1 action has no verified execution proof after the decision window.',
      },
    ],
    actions: [
      {
        id: 'verify-missing-execution-proof',
        priority: 'now',
        category: 'action-outcomes',
        title: 'Verify 1 action missing execution proof',
        why: 'Provenex cannot establish whether the operation ran.',
        nextStep: 'Open App settings and ask the alpha team for an outcome review before retrying.',
        appPath: '/settings',
      },
    ],
    honesty: 'This covers only the areas evaluated by this workspace. Absent areas are not evaluated, never safe.',
    ...overrides,
  };
}

function jsonFetch(body, status = 200, capture = {}) {
  return async (input, init) => {
    Object.assign(capture, { input: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('brief fetches the server-authored action feed and renders plain next steps', async () => {
  const capture = {};
  const out = await renderBrief('https://app-sandbox.provenex.ai', {
    env: KEY_ENV,
    fetchImpl: jsonFetch(payload(), 200, capture),
  });
  assert.equal(capture.input, 'https://app-sandbox.provenex.ai/api/sdk/v1/brief');
  assert.equal(capture.init.headers.authorization, 'Bearer pvx_sdk_test_workload_key');
  assert.match(out, /^Provenex brief: 1 thing needs your attention/m);
  assert.match(out, /^Do now$/m);
  assert.match(out, /Why: Provenex cannot establish whether the operation ran\./);
  assert.match(out, /Next: Open App settings/);
  assert.match(out, /Open: \/settings/);
  assert.match(out, /not evaluated, never safe\.$/m);
});

test('agent JSON is a strict projection and never passes through private fields', async () => {
  const serverBody = payload({
    privateRule: 'refund-account-binding',
    actions: [{
      ...payload().actions[0],
      engineAssessment: { hits: ['private-detector'] },
    }],
  });
  const out = await renderBrief('https://app-sandbox.provenex.ai', {
    format: 'json',
    env: KEY_ENV,
    fetchImpl: jsonFetch(serverBody),
  });
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), [
    'schemaVersion',
    'generatedAt',
    'workspaceId',
    'status',
    'headline',
    'health',
    'actions',
    'honesty',
  ]);
  assert.equal(parsed.privateRule, undefined);
  assert.equal(parsed.actions[0].engineAssessment, undefined);
});

test('brief rejects terminal controls, unknown paths, and duplicate actions', () => {
  assert.throws(
    () => validateBrief(payload({ headline: 'looks fine\u001b[2J' })),
    /invalid brief headline/,
  );
  assert.throws(
    () => validateBrief(payload({
      actions: [{ ...payload().actions[0], appPath: 'https://attacker.example' }],
    })),
    /invalid action App path/,
  );
  assert.throws(
    () => validateBrief(payload({ actions: [payload().actions[0], payload().actions[0]] })),
    /duplicate action/,
  );
  for (const unsafe of ['\u202e', '\u2028', '\ud800', '   ']) {
    assert.throws(
      () => validateBrief(payload({ headline: unsafe })),
      /invalid brief headline/,
    );
  }
  assert.throws(
    () => validateBrief(payload({ generatedAt: '2026-02-30T12:00:00Z' })),
    /invalid brief timestamp/,
  );
});

test('brief status agrees with the server-authored action priorities', () => {
  assert.throws(
    () => validateBrief(payload({ status: 'no-action' })),
    /contradictory brief status and actions/,
  );
  assert.throws(
    () => validateBrief(payload({
      status: 'needs-attention',
      actions: [{ ...payload().actions[0], priority: 'next' }],
    })),
    /contradictory brief status and actions/,
  );
  assert.doesNotThrow(() => validateBrief(payload({
    status: 'setup-needed',
    actions: [{ ...payload().actions[0], priority: 'next' }],
  })));
  assert.doesNotThrow(() => validateBrief(payload({
    status: 'no-action',
    actions: [],
  })));
});

test('App responses are bounded by streamed UTF-8 bytes, not JS characters', async () => {
  const oversized = JSON.stringify({ value: 'é'.repeat(APP_MAX_RESPONSE_BYTES) });
  await assert.rejects(
    fetchAppJson('https://app-sandbox.provenex.ai', '/api/sdk/v1/brief', {
      env: KEY_ENV,
      fetchImpl: async () => new Response(oversized),
    }),
    /response size bound/,
  );
});

test('brief arguments support one-time gateway setup and explicit agent format', () => {
  const fromEnv = parseArgs(['brief', '--format', 'json'], {
    PROVENEX_APP_GATEWAY_URL: 'https://app-sandbox.provenex.ai',
  });
  assert.equal(fromEnv.command, 'brief');
  assert.equal(fromEnv.gatewayUrl, 'https://app-sandbox.provenex.ai');
  assert.equal(fromEnv.format, 'json');

  const flagWins = parseArgs(
    ['brief', '--gateway-url', 'https://chosen.example'],
    { PROVENEX_APP_GATEWAY_URL: 'https://ignored.example' },
  );
  assert.equal(flagWins.gatewayUrl, 'https://chosen.example');
  assert.equal(flagWins.format, 'text');

  assert.throws(() => parseArgs(['brief'], {}), /PROVENEX_APP_GATEWAY_URL/);
  assert.throws(
    () => parseArgs(['brief', '--gateway-url', 'https://x.example', '--format', 'yaml']),
    /text or json/,
  );
  assert.throws(
    () => parseArgs(['scan', '.', '--format', 'json']),
    UsageError,
  );

  for (const extra of [
    ['--api-url', 'https://api.provenex.ai'],
    ['--force'],
    ['--max-files', '1'],
    ['--telemetry-format', 'otel'],
  ]) {
    assert.throws(
      () => parseArgs(['brief', '--gateway-url', 'https://x.example', ...extra], {}),
      /takes only --gateway-url and --format/,
    );
  }
});
