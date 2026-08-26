// `provenex-check explain <artifact.json>`: read a signed Provenex decision
// artifact the operator already holds and render what it establishes, what it
// does not, and whether the signature verifies.
//
// Accepted shapes, detected by their discriminating fields:
//   - a checkpoint result (what `@provenex/check/checkpoint` `decide()`
//     returns): `proceed` + `effectiveAction`, wrapping a gateway decision;
//   - a gateway decision: `decisionId` + `action` + `engineAssessment`;
//   - an Engine assessment (`/v1/score-closure` response): `correlation_key`
//     + signed `verdict`;
//   - a bare signed verdict: `artifact` + `signature` + `key_id`.
//
// Custody rule: when the artifact carries its exact signed canonical bytes,
// the verdict section is rendered FROM THOSE BYTES, so what the operator
// reads is what was signed. The convenience `artifact` object is compared
// against them and any drift is reported instead of silently preferred.
// Verification runs offline; nothing is uploaded and no service is called.

import { readFile } from 'node:fs/promises';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { UsageError } from './errors.mjs';

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Raw 32-byte Ed25519 public key wrapped as SPKI DER for node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeHexBytes(value, field) {
  if (typeof value === 'string') {
    if (!/^(?:[0-9a-f]{2})*$/.test(value)) {
      throw new UsageError(`${field} is not a lowercase hex byte string`);
    }
    return Buffer.from(value, 'hex');
  }
  // Legacy wire encoding: an integer array.
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Buffer.from(value);
  }
  throw new UsageError(`${field} is neither a hex string nor a legacy byte array`);
}

export function parseSignerKey(raw) {
  const compact = raw.trim();
  let bytes = null;
  if (/^[0-9a-fA-F]{64}$/.test(compact)) {
    bytes = Buffer.from(compact, 'hex');
  } else {
    const decoded = Buffer.from(compact, 'base64');
    if (decoded.length === 32) bytes = decoded;
  }
  if (bytes === null) {
    throw new UsageError('--signer-key must be a 32-byte Ed25519 public key as 64 hex characters or base64');
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  });
}

function detectShape(doc) {
  if (!isRecord(doc)) throw new UsageError('the artifact file must contain one JSON object');
  if (typeof doc.proceed === 'boolean' && typeof doc.effectiveAction === 'string') {
    return { kind: 'checkpoint-result', decision: doc.gatewayDecision ?? null, result: doc };
  }
  if (typeof doc.decisionId === 'string' && typeof doc.action === 'string') {
    return { kind: 'gateway-decision', decision: doc, result: null };
  }
  if (typeof doc.correlation_key === 'string' && isRecord(doc.verdict)) {
    return { kind: 'engine-assessment', assessment: doc };
  }
  if (isRecord(doc.artifact) && doc.signature !== undefined && typeof doc.key_id === 'string') {
    return { kind: 'signed-verdict', signed: doc };
  }
  throw new UsageError(
    'unrecognized artifact shape; expected a checkpoint result, gateway decision, Engine assessment, or signed verdict',
  );
}

function signedVerdictOf(shape) {
  if (shape.kind === 'signed-verdict') return shape.signed;
  if (shape.kind === 'engine-assessment') return shape.assessment.verdict;
  const assessment = shape.decision?.engineAssessment;
  return isRecord(assessment) && isRecord(assessment.verdict) ? assessment.verdict : null;
}

/**
 * Verify what the artifact lets us verify, and never claim more.
 *
 * Returns { status, detail, signedArtifact } where `signedArtifact` is the
 * artifact parsed from the exact signed bytes when they are present, else
 * null. Status vocabulary is closed: 'verified' (signature checked against
 * the provided key over the carried bytes), 'failed' (that check failed),
 * 'unverified-no-key' (bytes present, no key provided),
 * 'unverifiable-no-bytes' (no carried canonical bytes; re-canonicalizing a
 * reconstructed artifact is the engine's job, not this CLI's).
 */
export function verifySignedVerdict(signed, signerKey) {
  const signature = decodeHexBytes(signed.signature, 'signature');
  const rawBytes =
    signed.artifact_canonical_json === undefined || signed.artifact_canonical_json === ''
      ? Buffer.alloc(0)
      : decodeHexBytes(signed.artifact_canonical_json, 'artifact_canonical_json');
  if (rawBytes.length === 0) {
    return {
      status: 'unverifiable-no-bytes',
      detail: 'the artifact carries no signed canonical bytes; nothing here can check this signature',
      signedArtifact: null,
    };
  }
  let signedArtifact;
  try {
    signedArtifact = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    throw new UsageError('the signed canonical bytes are not valid JSON');
  }
  if (!isRecord(signedArtifact)) {
    throw new UsageError('the signed canonical bytes do not contain a verdict object');
  }
  if (!signerKey) {
    return {
      status: 'unverified-no-key',
      detail: 'signed bytes present; pass --signer-key to check the Ed25519 signature',
      signedArtifact,
    };
  }
  const ok = cryptoVerify(null, rawBytes, signerKey, signature);
  return ok
    ? { status: 'verified', detail: `Ed25519 signature verifies under key id ${signed.key_id}`, signedArtifact }
    : { status: 'failed', detail: 'Ed25519 signature does NOT verify under the provided key', signedArtifact };
}

function driftBetween(convenience, signedArtifact) {
  if (!isRecord(convenience) || !isRecord(signedArtifact)) return [];
  const drift = [];
  for (const field of ['output_receipt_id', 'verdict', 'risk', 'confidence', 'issued_at', 'binding_reason']) {
    const a = JSON.stringify(convenience[field] ?? null);
    const b = JSON.stringify(signedArtifact[field] ?? null);
    if (a !== b) drift.push(field);
  }
  const hitsA = Array.isArray(convenience.hits) ? convenience.hits.length : -1;
  const hitsB = Array.isArray(signedArtifact.hits) ? signedArtifact.hits.length : -1;
  if (hitsA !== hitsB) drift.push('hits');
  return drift;
}

function lines(out, rows) {
  for (const row of rows) out.push(row);
}

function renderDecision(out, shape) {
  if (shape.kind === 'checkpoint-result') {
    const r = shape.result;
    lines(out, [
      'Checkpoint decision (as recorded by the SDK)',
      `  mode:             ${r.mode}`,
      `  proceeded:        ${r.proceed}`,
      `  effective action: ${r.effectiveAction}`,
      `  would block:      ${r.wouldBlock === true}`,
      `  evidence status:  ${r.evidenceStatus}`,
    ]);
    if (isRecord(r.failure)) {
      lines(out, [
        `  failure:          ${r.failure.kind}: ${r.failure.reason}`,
        '  A failure result is a fail-posture outcome, not a policy decision.',
      ]);
    }
    out.push('');
  }
  const decision = shape.kind === 'gateway-decision' ? shape.decision : shape.decision ?? null;
  if (isRecord(decision)) {
    lines(out, [
      'Gateway decision',
      `  decision id: ${decision.decisionId}`,
      `  mode:        ${decision.mode}`,
      `  action:      ${decision.action}`,
      `  reason:      ${decision.reason}`,
      `  evidence:    ${decision.evidenceStatus}`,
    ]);
    out.push('');
  }
}

function renderVerdict(out, artifact, sourceNote) {
  lines(out, [
    `Engine verdict (${sourceNote})`,
    `  verdict:    ${artifact.verdict}`,
    `  risk:       ${artifact.risk ?? 'low'}`,
    `  confidence: ${artifact.confidence ?? 'confirmed'}`,
    `  issued at:  ${artifact.issued_at}`,
    `  action:     ${artifact.output_receipt_id} (HMAC token; the raw identifier never leaves the Edge)`,
  ]);
  if (artifact.binding_reason) out.push(`  binding:    ${artifact.binding_reason}`);
  out.push('');

  const hits = Array.isArray(artifact.hits) ? artifact.hits : [];
  if (hits.length === 0) {
    out.push('Findings: none. Read this with the coverage section below: a clear');
    out.push('is only as strong as what was evaluated.');
  } else {
    out.push(`Findings (${hits.length}, binding first)`);
    for (const hit of hits) {
      lines(out, [`  - ${hit.title} [${hit.policy_id}]`, `    ${hit.explanation}`]);
      const receipts = Array.isArray(hit.receipt_ids) ? hit.receipt_ids.length : 0;
      const enforcing = hit.enforcing === false ? 'detect-only policy' : 'enforcing policy';
      out.push(`    evidence: ${receipts} receipt(s) · ${enforcing}`);
    }
  }
  out.push('');

  const coverage = isRecord(artifact.coverage) ? artifact.coverage : null;
  if (coverage) {
    const dangling = Array.isArray(coverage.dangling_edges) ? coverage.dangling_edges.length : 0;
    const unresolved = Array.isArray(coverage.unresolved_zones) ? coverage.unresolved_zones.length : 0;
    lines(out, [
      'Coverage (what the decision could and could not see)',
      `  closure complete: ${coverage.closure_complete}`,
      `  depth reached:    ${coverage.depth_reached}${coverage.depth_capped ? ' (CAPPED)' : ''}`,
      `  unresolved:       ${dangling} dangling parent(s), ${unresolved} unclassified zone(s)`,
    ]);
    if (coverage.derived_evidence_only === true) {
      out.push('  every node came from an UNCONFIRMED mapping: derived evidence may not clear risk');
    }
    const entries = Array.isArray(coverage.policy_coverage) ? coverage.policy_coverage : [];
    for (const entry of entries) {
      const fired = (Array.isArray(artifact.hits) ? artifact.hits : []).some(
        (hit) => hit.policy_id === entry.policy_id,
      );
      let state;
      if (entry.not_applicable === true) state = 'not applicable';
      else if (!entry.evaluable) state = `NOT EVALUABLE${entry.gap_reason ? `: ${entry.gap_reason}` : ''}`;
      else if (fired) state = 'FIRED';
      else if (entry.gap_reason) state = `evaluated with gap: ${entry.gap_reason}`;
      else state = 'evaluated, clear';
      out.push(`  ${entry.policy_id}: ${state}`);
    }
    out.push('');
  }
}

export async function renderExplain(filePath, { signerKey = null } = {}) {
  const raw = await readFile(filePath);
  if (raw.byteLength > MAX_ARTIFACT_BYTES) {
    throw new UsageError(`artifact file exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  let doc;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new UsageError('the artifact file is not valid JSON');
  }
  const shape = detectShape(doc);
  const out = [];
  out.push(`Provenex explain: ${shape.kind}`);
  out.push('');
  renderDecision(out, shape);

  const signed = signedVerdictOf(shape);
  if (!signed) {
    lines(out, [
      'No Engine assessment is attached: this artifact records a decision made',
      'without verified evidence (fail posture), so there is no verdict to',
      'explain and no signature to check.',
      '',
    ]);
  } else {
    const verification = verifySignedVerdict(signed, signerKey);
    const artifact = verification.signedArtifact ?? signed.artifact;
    if (!isRecord(artifact)) throw new UsageError('the signed verdict carries no artifact');
    renderVerdict(
      out,
      artifact,
      verification.signedArtifact ? 'rendered from the exact signed bytes' : 'rendered from the unsigned convenience view',
    );
    out.push(`Signature: ${verification.status}`);
    out.push(`  ${verification.detail}`);
    if (verification.signedArtifact) {
      const drift = driftBetween(signed.artifact, verification.signedArtifact);
      if (drift.length > 0) {
        out.push(`  WARNING: the convenience view disagrees with the signed bytes on: ${drift.join(', ')}`);
      }
    }
    out.push('');
  }

  lines(out, [
    'What this does not prove: a verdict is an assessment, and a gateway',
    'decision is what the gateway says it decided. Only a PEP-signed',
    'enforcement receipt proves an action was actually withheld or allowed at',
    'a boundary, and only for the routed call it names.',
  ]);
  return `${out.join('\n')}\n`;
}
