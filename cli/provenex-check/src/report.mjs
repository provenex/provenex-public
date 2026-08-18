import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CHECK_DATA_POLICY, matchesCheckDataPolicy } from './policy.mjs';

export const PUBLIC_REPORT_VERSION = 'provenex-check-public-report.v1';
export const SIGNED_REPORT_VERSION = 'provenex-check-signed-report.v1';
export const TOOL_VERSION = '0.1.0-alpha.2';

export const PUBLIC_CATEGORIES = Object.freeze([
  'credentials',
  'agent_activity',
  'runtime_reliability',
  'cost_efficiency',
  'dependency_safety',
  'application_security',
  'platform_hardening',
  'data_governance',
  'cross_signal',
]);

const CATEGORY_SET = new Set(PUBLIC_CATEGORIES);
const EVIDENCE_LEVELS = new Set(['direct', 'correlated', 'tentative']);
const DISPOSITIONS = new Set(['confirmed', 'requires_review', 'preventable']);
const COVERAGE_STATES = new Set(['evaluated', 'partial', 'not_evaluated']);
const RESPONSE_KEYS = [
  'schema_version',
  'run_id',
  'exit_code',
  'status',
  'service_release',
  'retention_policy',
  'signed_report',
];
const REPORT_KEYS = [
  'schema_version',
  'tool_version',
  'command',
  'target',
  'generated_at',
  'status',
  'summary',
  'conclusion',
  'findings',
  'coverage',
  'limitations',
];
const FINDING_KEYS = [
  'id',
  'category',
  'disposition',
  'evidence_level',
  'title',
  'consequence',
  'evidence',
  'next_step',
];
const COVERAGE_KEYS = ['id', 'category', 'status', 'detail'];
const SIGNED_REPORT_KEYS = ['schema_version', 'report', 'canonical_report_json', 'signature'];
const SIGNATURE_KEYS = [
  'algorithm',
  'key_id',
  'public_key',
  'public_key_sha256',
  'signature',
  'meaning',
];
const MAX_CANONICAL_REPORT_BYTES = 16 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(message) {
  throw new Error(`API returned an invalid public report: ${message}`);
}

function assertExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    fail(`${label} has unsupported fields`);
  }
}

function scalarLength(value) {
  return [...value].length;
}

function assertDisplayText(value, maxScalars, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(`${label} must be text`);
  if ((!allowEmpty && value.length === 0) || scalarLength(value) > maxScalars) {
    fail(`${label} is outside its length bound`);
  }
  if ((!allowEmpty && value.trim().length === 0) || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    fail(`${label} is not sanitized display text`);
  }
}

function assertBoundedInteger(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`${label} is invalid`);
}

function isValidGeneratedAt(value) {
  if (typeof value !== 'string' || value.length > 35) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('cannot canonicalize unsupported JSON value');
}

function validateFinding(finding, index, counts) {
  assertExactObject(finding, FINDING_KEYS, `finding ${index + 1}`);
  const expectedId = `finding-${String(index + 1).padStart(4, '0')}`;
  if (finding.id !== expectedId) fail('finding ids must be opaque and sequential');
  if (!CATEGORY_SET.has(finding.category)) fail('finding category is unsupported');
  if (!DISPOSITIONS.has(finding.disposition)) fail('finding disposition is unsupported');
  if (!EVIDENCE_LEVELS.has(finding.evidence_level)) fail('finding evidence level is unsupported');
  assertDisplayText(finding.title, 256, 'finding title');
  assertDisplayText(finding.consequence, 1024, 'finding consequence');
  assertDisplayText(finding.evidence, 2048, 'finding evidence');
  assertDisplayText(finding.next_step, 1024, 'finding next step');
  counts[finding.evidence_level] += 1;
}

function validateCoverage(coverage, index, categories) {
  assertExactObject(coverage, COVERAGE_KEYS, `coverage ${index + 1}`);
  const expectedId = `coverage-${String(index + 1).padStart(4, '0')}`;
  if (coverage.id !== expectedId) fail('coverage ids must be opaque and sequential');
  if (!CATEGORY_SET.has(coverage.category) || categories.has(coverage.category)) {
    fail('coverage categories must be supported and unique');
  }
  categories.add(coverage.category);
  if (!COVERAGE_STATES.has(coverage.status)) fail('coverage status is unsupported');
  assertDisplayText(coverage.detail, 512, 'coverage detail');
}

function validateReport(report, expected) {
  assertExactObject(report, REPORT_KEYS, 'report');
  if (report.schema_version !== PUBLIC_REPORT_VERSION) fail('report schema is unsupported');
  if (report.tool_version !== TOOL_VERSION) fail('report tool version is unsupported');
  if (report.command !== 'scan' && report.command !== 'audit') fail('report command is unsupported');
  if (report.command !== expected.command) fail('report command differs from the approved request');
  assertDisplayText(report.target, 255, 'report target');
  if (Buffer.byteLength(report.target) > 255 || report.target !== expected.target) {
    fail('report target differs from the approved request');
  }
  if (!isValidGeneratedAt(report.generated_at)) {
    fail('report generation timestamp is invalid');
  }
  if (report.status !== 'complete' && report.status !== 'incomplete') fail('report status is invalid');

  assertExactObject(report.summary, ['total', 'direct', 'correlated', 'tentative'], 'summary');
  for (const key of ['total', 'direct', 'correlated', 'tentative']) {
    assertBoundedInteger(report.summary[key], 2000, `summary ${key}`);
  }
  assertDisplayText(report.conclusion, 1024, 'report conclusion');
  if (!Array.isArray(report.findings) || report.findings.length > 2000) fail('findings are invalid');
  const counts = { direct: 0, correlated: 0, tentative: 0 };
  report.findings.forEach((finding, index) => validateFinding(finding, index, counts));
  if (
    report.summary.total !== report.findings.length
    || report.summary.direct !== counts.direct
    || report.summary.correlated !== counts.correlated
    || report.summary.tentative !== counts.tentative
    || counts.direct + counts.correlated + counts.tentative !== report.summary.total
  ) {
    fail('summary does not match emitted findings');
  }

  if (!Array.isArray(report.coverage) || report.coverage.length > PUBLIC_CATEGORIES.length) {
    fail('coverage is invalid');
  }
  const coverageCategories = new Set();
  report.coverage.forEach((coverage, index) => validateCoverage(coverage, index, coverageCategories));
  if (!Array.isArray(report.limitations) || report.limitations.length > 8) fail('limitations are invalid');
  report.limitations.forEach((limitation) => assertDisplayText(limitation, 512, 'limitation'));
  return report;
}

function verifyEnvelope(signedReport, expected) {
  assertExactObject(signedReport, SIGNED_REPORT_KEYS, 'signed report');
  if (signedReport.schema_version !== SIGNED_REPORT_VERSION) fail('signed report schema is unsupported');
  const report = validateReport(signedReport.report, expected);
  if (
    typeof signedReport.canonical_report_json !== 'string'
    || Buffer.byteLength(signedReport.canonical_report_json) > MAX_CANONICAL_REPORT_BYTES
  ) {
    fail('canonical report is outside its byte bound');
  }
  let embedded;
  try {
    embedded = JSON.parse(signedReport.canonical_report_json);
  } catch {
    fail('canonical report is not JSON');
  }
  if (!isDeepStrictEqual(embedded, report)) fail('canonical report differs from the report object');
  if (canonicalJson(embedded) !== signedReport.canonical_report_json) {
    fail('canonical report is not recursively key-sorted compact JSON');
  }

  const signature = signedReport.signature;
  assertExactObject(signature, SIGNATURE_KEYS, 'signature');
  if (signature.algorithm !== 'ed25519' || signature.meaning !== 'self-consistency-only') {
    fail('signature semantics are unsupported');
  }
  if (!/^run-[0-9a-f]{16}$/.test(signature.key_id)) fail('signature key id is invalid');
  if (!/^[0-9a-f]{64}$/.test(signature.public_key)) fail('signature public key is invalid');
  if (!/^[0-9a-f]{64}$/.test(signature.public_key_sha256)) fail('public key digest is invalid');
  if (!/^[0-9a-f]{128}$/.test(signature.signature)) fail('signature bytes are invalid');

  const rawPublicKey = Buffer.from(signature.public_key, 'hex');
  const digest = createHash('sha256').update(rawPublicKey).digest('hex');
  if (digest !== signature.public_key_sha256 || signature.key_id !== `run-${digest.slice(0, 16)}`) {
    fail('signature key identifiers are inconsistent');
  }
  let verified = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: 'der',
      type: 'spki',
    });
    verified = verifySignature(
      null,
      Buffer.from(signedReport.canonical_report_json, 'utf8'),
      publicKey,
      Buffer.from(signature.signature, 'hex'),
    );
  } catch {
    fail('signature could not be verified');
  }
  if (!verified) fail('signature verification failed');
  return report;
}

export function validateHostedResponse(body, expected) {
  assertExactObject(body, RESPONSE_KEYS, 'response');
  if (body.schema_version !== 'provenex-check-response.v1') fail('response schema is unsupported');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.run_id)) {
    fail('run id is invalid');
  }
  if (![0, 1, 3].includes(body.exit_code)) fail('exit code is invalid');
  if (body.status !== 'complete' && body.status !== 'incomplete') fail('response status is invalid');
  if (
    typeof body.service_release !== 'string'
    || body.service_release.length < 1
    || body.service_release.length > 128
    || !/^[A-Za-z0-9._-]+$/.test(body.service_release)
  ) {
    fail('service release is not a bounded opaque identifier');
  }
  if (!matchesCheckDataPolicy(body.retention_policy)) fail('applied retention policy differs from consent');
  const report = verifyEnvelope(body.signed_report, expected);
  if (report.status !== body.status) fail('response and report status differ');
  if ((body.status === 'incomplete') !== (body.exit_code === 3)) fail('status and exit code differ');
  if (body.status === 'complete') {
    const expectedExit = report.summary.total === 0 ? 0 : 1;
    if (body.exit_code !== expectedExit) fail('finding count and exit code differ');
  }
  return body;
}

export { CHECK_DATA_POLICY };
