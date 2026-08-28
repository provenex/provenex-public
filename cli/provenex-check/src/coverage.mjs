// `provenex-check coverage --gateway-url <origin>`: ask YOUR Provenex App
// gateway what it can prove about your workspace right now, and render it
// without embellishment. The gateway's own honesty rule travels with the
// data: connected is credentials, not coverage; absent areas are "not
// evaluated", never "safe". The workload key is read from PROVENEX_SDK_KEY
// only; keys are never accepted on the command line.

import {
  fetchAppJson,
  plainRecord,
  safeIdentifier,
  safeText,
  safeTimestamp,
  validateGatewayOrigin,
} from './app-client.mjs';
import { UsageError } from './errors.mjs';

export { validateGatewayOrigin };

const AREA_STATES = new Set([
  'covered',
  'partial',
  'not-connected',
  'not-assessed-here',
]);

export function validateCoverage(value) {
  if (
    !plainRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.areas)
    || value.areas.length > 12
  ) {
    throw new UsageError('the gateway returned an unsupported coverage schema');
  }
  const areaIds = new Set();
  const areas = value.areas.map((area) => {
    if (!plainRecord(area)) throw new UsageError('the gateway returned an invalid coverage area');
    const id = safeIdentifier(area.area, 'coverage area id');
    if (areaIds.has(id)) throw new UsageError('the gateway returned a duplicate coverage area');
    areaIds.add(id);
    if (!AREA_STATES.has(area.state)) {
      throw new UsageError('the gateway returned an invalid coverage area state');
    }
    const projected = {
      area: id,
      state: area.state,
      evidence: safeText(area.evidence, 'coverage evidence', { maximum: 1_024 }),
    };
    if (plainRecord(area.counts)) {
      const entries = Object.entries(area.counts);
      if (entries.length > 16) throw new UsageError('the gateway returned too many custody counts');
      projected.counts = Object.fromEntries(entries.map(([state, count]) => {
        const safeState = safeIdentifier(state, 'custody state');
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new UsageError('the gateway returned an invalid custody count');
        }
        return [safeState, count];
      }));
    }
    if (Object.hasOwn(area, 'truncated')) {
      if (typeof area.truncated !== 'boolean') {
        throw new UsageError('the gateway returned an invalid custody truncation flag');
      }
      projected.truncated = area.truncated;
    }
    if (Object.hasOwn(area, 'oldestUnsettledEnqueuedAt')) {
      projected.oldestUnsettledEnqueuedAt = safeTimestamp(
        area.oldestUnsettledEnqueuedAt,
        'oldest unsettled timestamp',
      );
    }
    if (Object.hasOwn(area, 'sampledUnsettledEnqueuedAt')) {
      projected.sampledUnsettledEnqueuedAt = safeTimestamp(
        area.sampledUnsettledEnqueuedAt,
        'sampled unsettled timestamp',
      );
    }
    return projected;
  });
  return {
    schemaVersion: 1,
    generatedAt: safeTimestamp(value.generatedAt, 'coverage timestamp'),
    workspaceId: safeIdentifier(value.workspaceId, 'workspace id'),
    honesty: safeText(value.honesty, 'coverage note', { maximum: 768 }),
    areas,
  };
}

function stateBadge(state) {
  return {
    covered: 'covered',
    partial: 'PARTIAL',
    'not-connected': 'NOT CONNECTED',
    'not-assessed-here': 'not assessed here',
  }[state] ?? String(state);
}

export async function renderCoverage(gatewayUrl, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const body = validateCoverage(
    await fetchAppJson(gatewayUrl, '/api/sdk/v1/coverage', { env, fetchImpl }),
  );

  const out = [];
  out.push(`Provenex coverage: workspace ${body.workspaceId ?? '(unnamed)'}`);
  out.push(`  as of ${body.generatedAt}`);
  out.push('');
  for (const area of body.areas) {
    out.push(`${String(area.area)}: ${stateBadge(area.state)}`);
    if (typeof area.evidence === 'string' && area.evidence) {
      out.push(`  ${area.evidence}`);
    }
    if (area.counts && typeof area.counts === 'object') {
      const counts = Object.entries(area.counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(' · ');
      if (counts) out.push(`  custody: ${counts}`);
    }
    if (typeof area.oldestUnsettledEnqueuedAt === 'string') {
      out.push(`  oldest unsettled action enqueued at ${area.oldestUnsettledEnqueuedAt}`);
    }
    if (typeof area.sampledUnsettledEnqueuedAt === 'string') {
      out.push(`  sampled unsettled action enqueued at ${area.sampledUnsettledEnqueuedAt}`);
    }
    out.push('');
  }
  if (typeof body.honesty === 'string') {
    out.push(body.honesty);
  }
  return `${out.join('\n')}\n`;
}
