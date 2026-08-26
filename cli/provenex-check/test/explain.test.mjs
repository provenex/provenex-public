import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseSignerKey, renderExplain, verifySignedVerdict } from '../src/explain.mjs';
import { parseArgs } from '../src/args.mjs';
import { UsageError } from '../src/errors.mjs';

const token = (digit) => `hmac-sha256:${digit.repeat(64)}`;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicHex = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');

function artifact(overrides = {}) {
  return {
    output_receipt_id: token('1'),
    verdict: 'red',
    risk: 'high',
    confidence: 'confirmed',
    hits: [
      {
        policy_id: 'refund-account-binding',
        title: 'A refund must settle to the account it was approved for',
        explanation:
          'The registered action’s resource is owned by a different application tenant than the requesting subject.'.replace('’', "'"),
        receipt_ids: [token('1')],
      },
    ],
    coverage: {
      closure_complete: true,
      depth_reached: 3,
      depth_capped: false,
      dangling_edges: [],
      unresolved_zones: [],
      policy_coverage: [
        { policy_id: 'refund-account-binding', evaluable: true, gap_reason: null },
        { policy_id: 'refund-amount-limit', evaluable: true, gap_reason: null },
        { policy_id: 'credential-target-mismatch', evaluable: false, gap_reason: null, not_applicable: true },
      ],
    },
    closure_receipt_ids: [token('1')],
    issued_at: '2026-08-26T12:00:00Z',
    binding_reason: 'refund-account-binding',
    ...overrides,
  };
}

function signedVerdict(theArtifact = artifact(), { tamperConvenience = false } = {}) {
  const canonical = Buffer.from(JSON.stringify(theArtifact), 'utf8');
  const signature = cryptoSign(null, canonical, privateKey);
  const convenience = tamperConvenience ? { ...theArtifact, verdict: 'policy-cleared' } : theArtifact;
  return {
    artifact: convenience,
    signature: signature.toString('hex'),
    key_id: 'tenant-key-1',
    artifact_canonical_json: canonical.toString('hex'),
  };
}

function assessment(signed = signedVerdict()) {
  return {
    correlation_key: token('1'),
    verdict: signed,
    trace: {},
    evidence: { band: 'observed' },
  };
}

function checkpointResult(signed = signedVerdict()) {
  return {
    mode: 'prevent',
    proceed: false,
    effectiveAction: 'block',
    wouldBlock: false,
    evidenceStatus: 'verified',
    gatewayDecision: {
      schemaVersion: 1,
      decisionId: 'dec_01',
      mode: 'prevent',
      action: 'block',
      reason: 'configured policy selected block',
      engineAssessment: assessment(signed),
      evidenceStatus: 'verified',
    },
  };
}

async function writeArtifact(doc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pvx-explain-'));
  const file = path.join(dir, 'artifact.json');
  await writeFile(file, JSON.stringify(doc));
  return file;
}

test('explains a full checkpoint result and renders from the signed bytes', async () => {
  const file = await writeArtifact(checkpointResult());
  const out = await renderExplain(file, { signerKey: parseSignerKey(rawPublicHex) });
  assert.match(out, /Provenex explain: checkpoint-result/);
  assert.match(out, /effective action: block/);
  assert.match(out, /decision id: dec_01/);
  assert.match(out, /rendered from the exact signed bytes/);
  assert.match(out, /verdict:\s+red/);
  assert.match(out, /A refund must settle to the account it was approved for/);
  assert.match(out, /refund-account-binding: FIRED/);
  assert.match(out, /refund-amount-limit: evaluated, clear/);
  assert.match(out, /credential-target-mismatch: not applicable/);
  assert.match(out, /Signature: verified/);
  assert.match(out, /Only a PEP-signed/);
});

test('without a key the signature status is honest, never assumed', async () => {
  const file = await writeArtifact(assessment());
  const out = await renderExplain(file, {});
  assert.match(out, /Provenex explain: engine-assessment/);
  assert.match(out, /Signature: unverified-no-key/);
  assert.doesNotMatch(out, /Signature: verified/);
});

test('a wrong key fails the signature and says so', async () => {
  const otherRaw = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  const file = await writeArtifact(signedVerdict());
  const out = await renderExplain(file, { signerKey: parseSignerKey(otherRaw) });
  assert.match(out, /Provenex explain: signed-verdict/);
  assert.match(out, /Signature: failed/);
  assert.match(out, /does NOT verify/);
});

test('a convenience view that disagrees with the signed bytes is called out', async () => {
  const file = await writeArtifact(signedVerdict(artifact(), { tamperConvenience: true }));
  const out = await renderExplain(file, { signerKey: parseSignerKey(rawPublicHex) });
  // The signed bytes win the render; the tampered convenience view is flagged.
  assert.match(out, /verdict:\s+red/);
  assert.match(out, /WARNING: the convenience view disagrees with the signed bytes on: verdict/);
});

test('missing canonical bytes are unverifiable, never silently re-canonicalized', () => {
  const signed = signedVerdict();
  signed.artifact_canonical_json = '';
  const verification = verifySignedVerdict(signed, parseSignerKey(rawPublicHex));
  assert.equal(verification.status, 'unverifiable-no-bytes');
  assert.equal(verification.signedArtifact, null);
});

test('legacy integer-array signatures still verify', () => {
  const signed = signedVerdict();
  signed.signature = Array.from(Buffer.from(signed.signature, 'hex'));
  const verification = verifySignedVerdict(signed, parseSignerKey(rawPublicHex));
  assert.equal(verification.status, 'verified');
});

test('a failure result with no assessment explains the fail posture instead', async () => {
  const file = await writeArtifact({
    mode: 'prevent',
    proceed: false,
    effectiveAction: 'block',
    wouldBlock: false,
    evidenceStatus: 'unavailable',
    gatewayDecision: null,
    failure: { kind: 'timeout', reason: 'Provenex App gateway exceeded the 2000ms budget' },
  });
  const out = await renderExplain(file, {});
  assert.match(out, /failure:\s+timeout/);
  assert.match(out, /fail-posture outcome, not a policy decision/);
  assert.match(out, /No Engine assessment is attached/);
});

test('unknown shapes and malformed files are refused, not guessed at', async () => {
  const notJson = await writeArtifact({});
  await assert.rejects(renderExplain(notJson, {}), UsageError);
  const dir = await mkdtemp(path.join(tmpdir(), 'pvx-explain-'));
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, 'not json at all');
  await assert.rejects(renderExplain(bad, {}), UsageError);
});

test('signer keys parse from hex and base64 and reject everything else', () => {
  assert.ok(parseSignerKey(rawPublicHex));
  assert.ok(parseSignerKey(Buffer.from(rawPublicHex, 'hex').toString('base64')));
  for (const bad of ['', 'zz', 'deadbeef', rawPublicHex.slice(0, 62)]) {
    assert.throws(() => parseSignerKey(bad), UsageError);
  }
});

test('explain argument rules: one file, only --signer-key, nowhere else', () => {
  const options = parseArgs(['explain', 'artifact.json', '--signer-key', rawPublicHex]);
  assert.equal(options.command, 'explain');
  assert.equal(options.signerKey, rawPublicHex);
  assert.equal(path.basename(options.targetPath), 'artifact.json');
  assert.throws(() => parseArgs(['explain']), UsageError);
  assert.throws(() => parseArgs(['explain', 'a.json', '--json', 'out.json']), UsageError);
  assert.throws(() => parseArgs(['scan', '.', '--signer-key', rawPublicHex]), UsageError);
});
