// `provenex-check coverage --gateway-url <origin>`: ask YOUR Provenex App
// gateway what it can prove about your workspace right now, and render it
// without embellishment. The gateway's own honesty rule travels with the
// data: connected is credentials, not coverage; absent areas are "not
// evaluated", never "safe". The workload key is read from PROVENEX_SDK_KEY
// only; keys are never accepted on the command line.

import { UsageError } from './errors.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const SDK_KEY = /^pvx_sdk_[A-Za-z0-9_-]{8,}$/;

export function validateGatewayOrigin(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new UsageError('--gateway-url must be an absolute URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UsageError('--gateway-url must not contain credentials, query, or fragment');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new UsageError('--gateway-url must use HTTPS (HTTP is allowed only on loopback)');
  }
  if (url.hostname === 'provenex-verdict.fly.dev') {
    throw new UsageError('--gateway-url must be your Provenex App gateway, not the hosted Engine');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UsageError('--gateway-url must be a base origin without an API path');
  }
  return url;
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
  const origin = validateGatewayOrigin(gatewayUrl);
  const key = (env.PROVENEX_SDK_KEY ?? '').trim();
  if (!SDK_KEY.test(key)) {
    throw new UsageError(
      'set PROVENEX_SDK_KEY to a tenant-scoped pvx_sdk_ workload key; keys are never accepted as arguments',
    );
  }
  const endpoint = new URL('/api/sdk/v1/coverage', origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new UsageError(`the gateway did not answer within ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new UsageError('the gateway request failed; check --gateway-url and your network');
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new UsageError('the gateway response exceeded the coverage size bound');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new UsageError(`the gateway returned HTTP ${response.status} without valid JSON`);
  }
  if (!response.ok) {
    throw new UsageError(`the gateway refused coverage: HTTP ${response.status}: ${body?.error ?? 'no detail'}`);
  }
  if (body?.schemaVersion !== 1 || !Array.isArray(body.areas)) {
    throw new UsageError('the gateway returned an unsupported coverage schema');
  }

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
    out.push('');
  }
  if (typeof body.honesty === 'string') {
    out.push(body.honesty);
  }
  return `${out.join('\n')}\n`;
}
