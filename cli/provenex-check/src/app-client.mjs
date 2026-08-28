import { UsageError } from './errors.mjs';

export const APP_REQUEST_TIMEOUT_MS = 10_000;
export const APP_MAX_RESPONSE_BYTES = 256 * 1024;

const SDK_KEY = /^pvx_sdk_[A-Za-z0-9_-]{8,}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const NON_APP_HOSTS = new Set([
  'api.provenex.ai',
  'provenex-verdict.fly.dev',
]);

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
  const normalizedHost = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (NON_APP_HOSTS.has(normalizedHost)) {
    throw new UsageError('--gateway-url must be your Provenex App gateway, not the hosted Engine');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UsageError('--gateway-url must be a base origin without an API path');
  }
  return url;
}

export function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeText(value, label, { minimum = 1, maximum = 512 } = {}) {
  if (
    typeof value !== 'string'
    || value.length < minimum
    || (minimum > 0 && value.trim().length === 0)
    || Buffer.byteLength(value, 'utf8') > maximum
    || UNSAFE_TEXT.test(value)
  ) {
    throw new UsageError(`the gateway returned an invalid ${label}`);
  }
  return value;
}

export function safeIdentifier(value, label) {
  const text = safeText(value, label, { maximum: 96 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(text)) {
    throw new UsageError(`the gateway returned an invalid ${label}`);
  }
  return text;
}

export function safeTimestamp(value, label) {
  const text = safeText(value, label, { maximum: 40 });
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/u.exec(text);
  const parsed = new Date(text);
  if (!match || Number.isNaN(parsed.getTime()) || [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ].some((part, index) => part !== Number(match[index + 1]))) {
    throw new UsageError(`the gateway returned an invalid ${label}`);
  }
  return text;
}

async function readBoundedBody(response, controller) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new UsageError('the gateway returned a response without a readable body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new UsageError('the gateway returned an unreadable response body');
      }
      bytes += value.byteLength;
      if (bytes > APP_MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new UsageError('the gateway response exceeded the App response size bound');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (error instanceof TypeError) {
      throw new UsageError('the gateway returned a response that was not valid UTF-8');
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return text;
}

export async function fetchAppJson(
  gatewayUrl,
  path,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const origin = validateGatewayOrigin(gatewayUrl);
  const key = (env.PROVENEX_SDK_KEY ?? '').trim();
  if (!SDK_KEY.test(key)) {
    throw new UsageError(
      'set PROVENEX_SDK_KEY to a tenant-scoped pvx_sdk_ workload key; keys are never accepted as arguments',
    );
  }
  const endpoint = new URL(path, origin);
  const controller = new AbortController();
  let timedOut = false;
  let timer;

  const request = (async () => {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    });
    const raw = await readBoundedBody(response, controller);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new UsageError(`the gateway returned HTTP ${response.status} without valid JSON`);
    }
    if (!response.ok) {
      let detail = 'no detail';
      if (plainRecord(body) && typeof body.error === 'string') {
        try {
          detail = safeText(body.error, 'error detail', { maximum: 256 });
        } catch {
          detail = 'invalid error detail';
        }
      }
      throw new UsageError(`the gateway refused the request: HTTP ${response.status}: ${detail}`);
    }
    return body;
  })();

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new UsageError(`the gateway did not answer within ${APP_REQUEST_TIMEOUT_MS}ms`));
    }, APP_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (timedOut || error?.name === 'AbortError') {
      throw new UsageError(`the gateway did not answer within ${APP_REQUEST_TIMEOUT_MS}ms`);
    }
    throw new UsageError('the gateway request failed; check --gateway-url and your network');
  } finally {
    clearTimeout(timer);
  }
}
