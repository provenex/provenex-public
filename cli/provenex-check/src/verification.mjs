import { createHmac } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT_LIMITS } from './client.mjs';
import { UsageError } from './errors.mjs';
import { validateHostedResponse } from './report.mjs';

export const LOCAL_VERIFICATION_VERSION = 'provenex-check-local-verification.v1';

export const VERIFICATION_OUTCOMES = Object.freeze({
  stillPresent: 'still-present',
  notVerifiable: 'not-verifiable',
});

export function deriveProjectScope(apiKey, canonicalRoot) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('cannot derive a project scope without an API credential');
  }
  if (typeof canonicalRoot !== 'string' || !path.isAbsolute(canonicalRoot)) {
    throw new Error('cannot derive a project scope without a canonical absolute root');
  }
  const digest = createHmac('sha256', apiKey)
    .update('provenex-check-project-scope.v1\0', 'utf8')
    .update(canonicalRoot, 'utf8')
    .digest('hex');
  return `pvxproj-${digest}`;
}

function failPrior(message) {
  throw new UsageError(`prior Check report ${message}`);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * A comparison report is local input, never scan evidence. Keep it outside the
 * canonical project root so generic JSON collection cannot include it in the
 * new hosted request.
 */
export async function assertPriorResponseOutsideRoot(file, root) {
  let canonical;
  try {
    canonical = await realpath(file);
  } catch (error) {
    if (error?.code === 'ENOENT') failPrior('does not exist');
    throw error;
  }
  if (isWithin(root, canonical)) {
    failPrior('must be outside the scanned project so it cannot be uploaded as evidence');
  }
}

/**
 * Read a prior CLI JSON output without following links or accepting a report
 * another local user could replace. The pathname and bytes remain local.
 */
export async function loadPriorResponse(file, expected) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') failPrior('does not exist');
    if (error?.code === 'ELOOP') failPrior('must not be a symbolic link');
    throw error;
  }

  let serialized;
  try {
    const info = await handle.stat();
    if (!info.isFile()) failPrior('must be a regular file');
    if (info.size > CLIENT_LIMITS.maxResponseBytes) {
      failPrior(`exceeds ${CLIENT_LIMITS.maxResponseBytes} bytes`);
    }
    if (process.platform !== 'win32') {
      if ((info.mode & 0o077) !== 0) failPrior('must be owner-only (chmod 600)');
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        failPrior('must be owned by the current user');
      }
    }
    serialized = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  let body;
  try {
    body = JSON.parse(serialized);
  } catch {
    failPrior('is not valid JSON');
  }
  try {
    return validateHostedResponse(body, expected);
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.replace(/^API returned an invalid public report:\s*/u, '')
      : 'validation failed';
    failPrior(`failed validation: ${detail}`);
  }
}

/**
 * Compare only stable, server-authored verification keys. This deliberately
 * does not call an absent finding fixed. V2 binds a comparison to an opaque
 * credential-keyed local project scope, but the report does not yet carry
 * detector-specific proof that a missing candidate was evaluated again.
 */
export function comparePriorResponse(previous, current) {
  const previousReport = previous.signed_report.report;
  const currentReport = current.signed_report.report;
  const sameProject = previousReport.project_scope === currentReport.project_scope;
  const currentByKey = new Map(currentReport.findings
    .filter((finding) => finding.owner_view.verification_key !== null)
    .map((finding) => [finding.owner_view.verification_key, finding]));

  const findings = previousReport.findings.map((finding) => {
    const verificationKey = finding.owner_view.verification_key;
    if (!sameProject) {
      return {
        verification_key: verificationKey,
        verification_family: finding.owner_view.verification_family,
        headline: finding.owner_view.headline,
        outcome: VERIFICATION_OUTCOMES.notVerifiable,
        reason: 'The opaque local project scope differs between runs.',
      };
    }
    if (verificationKey === null) {
      return {
        verification_key: null,
        verification_family: finding.owner_view.verification_family,
        headline: finding.owner_view.headline,
        outcome: VERIFICATION_OUTCOMES.notVerifiable,
        reason: 'This detector does not yet provide a stable verification key.',
      };
    }
    if (currentByKey.has(verificationKey)) {
      return {
        verification_key: verificationKey,
        verification_family: finding.owner_view.verification_family,
        headline: finding.owner_view.headline,
        outcome: VERIFICATION_OUTCOMES.stillPresent,
        reason: 'The same stable finding key was observed again.',
      };
    }
    return {
      verification_key: verificationKey,
      verification_family: finding.owner_view.verification_family,
      headline: finding.owner_view.headline,
      outcome: VERIFICATION_OUTCOMES.notVerifiable,
      reason: 'The prior key was not observed, but this report does not prove that the exact candidate and evidence scope were evaluated again.',
    };
  });

  return {
    schema_version: LOCAL_VERIFICATION_VERSION,
    previous_run_id: previous.run_id,
    current_run_id: current.run_id,
    same_project_scope: sameProject,
    findings,
  };
}
