import { homedir } from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { UsageError } from './errors.mjs';
import { validateHostedResponse } from './report.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const PRODUCTION_API_ORIGIN = 'https://api.provenex.ai';

export const CLIENT_LIMITS = Object.freeze({
  maxResponseBytes: 32 * 1024 * 1024,
  uploadAndHeadersTotalMs: 30 * 60 * 1000,
  responseBodyIdleMs: 60 * 1000,
  responseBodyTotalMs: 10 * 60 * 1000,
});

export function isLoopbackApiOrigin(origin) {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError('API URL must be a valid absolute URL');
  }
  if (url.username || url.password) throw new UsageError('API URL must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new UsageError('API URL must be an origin without a path, query, or fragment');
  }
  const loopbackDevelopmentOrigin = isLoopbackApiOrigin(url.origin)
    && (url.protocol === 'http:' || url.protocol === 'https:');
  if (url.origin !== PRODUCTION_API_ORIGIN && !loopbackDevelopmentOrigin) {
    throw new UsageError(
      `API URL must be ${PRODUCTION_API_ORIGIN} (HTTP or HTTPS is allowed only for loopback development)`,
    );
  }
  return url.origin;
}

export function apiKeyConfigPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(homedir(), '.config');
  return path.join(base, 'provenex', 'check.json');
}

export async function loadApiKey(origin) {
  const normalizedOrigin = validateApiOrigin(origin);
  if (isLoopbackApiOrigin(normalizedOrigin)) {
    if (process.env.PROVENEX_CHECK_DEV_API_KEY) return process.env.PROVENEX_CHECK_DEV_API_KEY;
    throw new UsageError(
      'Loopback development API key not found; set PROVENEX_CHECK_DEV_API_KEY. '
      + 'Loopback endpoints never read PROVENEX_API_KEY or the production API key config file.',
    );
  }
  if (process.env.PROVENEX_API_KEY) return process.env.PROVENEX_API_KEY;
  const file = apiKeyConfigPath();
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new UsageError(
        'API key not found; obtain a Check API key from your Provenex trial administrator '
        + '(self-serve signup is not available in alpha), then set PROVENEX_API_KEY '
        + 'or create the owner-only config file',
      );
    }
    if (error?.code === 'ELOOP') throw new UsageError('API key config must not be a symbolic link');
    throw error;
  }
  let serialized;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UsageError('API key config must be a regular file');
    if (info.size > MAX_CONFIG_BYTES) throw new UsageError('API key config is unexpectedly large');
    if (process.platform !== 'win32') {
      if ((info.mode & 0o077) !== 0) throw new UsageError('API key config must be owner-only (chmod 600)');
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new UsageError('API key config must be owned by the current user');
      }
    }
    serialized = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new UsageError('API key config is not valid JSON');
  }
  if (typeof parsed?.api_key !== 'string' || parsed.api_key.length === 0) {
    throw new UsageError('API key config must contain a non-empty api_key string');
  }
  return parsed.api_key;
}

function requirePositiveTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function cancelBody(reader, controller) {
  controller?.abort();
  void reader?.cancel().catch(() => {});
}

async function readWithDeadline(reader, idleMs, deadline) {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw new Error('API response body total timeout expired');
  const totalDeadlineFirst = remainingMs <= idleMs;
  const waitMs = Math.min(idleMs, remainingMs);
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          totalDeadlineFirst
            ? 'API response body total timeout expired'
            : 'API response body idle timeout expired',
        )), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readBoundedJson(response, {
  maxBytes = CLIENT_LIMITS.maxResponseBytes,
  idleTimeoutMs = CLIENT_LIMITS.responseBodyIdleMs,
  totalTimeoutMs = CLIENT_LIMITS.responseBodyTotalMs,
  controller,
} = {}) {
  requirePositiveTimeout(maxBytes, 'API response byte limit');
  requirePositiveTimeout(idleTimeoutMs, 'API response body idle timeout');
  requirePositiveTimeout(totalTimeoutMs, 'API response body total timeout');
  const declared = response.headers.get('content-length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    cancelBody(response.body, controller);
    throw new Error(`API response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('API returned an empty response');
  const reader = response.body.getReader();
  const deadline = performance.now() + totalTimeoutMs;
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, idleTimeoutMs, deadline);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancelBody(reader, controller);
        throw new Error(`API response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelBody(reader, controller);
    throw error;
  }
  const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new Error('API returned invalid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('API returned invalid JSON');
  }
}

export async function submitRun({
  origin,
  apiKey,
  serializedRequest,
  expected,
  fetchImpl = fetch,
  limits = {},
}) {
  const uploadAndHeadersTotalMs = requirePositiveTimeout(
    limits.uploadAndHeadersTotalMs ?? CLIENT_LIMITS.uploadAndHeadersTotalMs,
    'API upload and response headers timeout',
  );
  const responseBodyIdleMs = requirePositiveTimeout(
    limits.responseBodyIdleMs ?? CLIENT_LIMITS.responseBodyIdleMs,
    'API response body idle timeout',
  );
  const responseBodyTotalMs = requirePositiveTimeout(
    limits.responseBodyTotalMs ?? CLIENT_LIMITS.responseBodyTotalMs,
    'API response body total timeout',
  );
  const maxResponseBytes = requirePositiveTimeout(
    limits.maxResponseBytes ?? CLIENT_LIMITS.maxResponseBytes,
    'API response byte limit',
  );
  const controller = new AbortController();
  let uploadAndHeadersTimedOut = false;
  const timer = setTimeout(() => {
    uploadAndHeadersTimedOut = true;
    controller.abort();
  }, uploadAndHeadersTotalMs);
  let response;
  try {
    response = await fetchImpl(new URL('/v1/check/runs', origin), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'provenex-check/0.1.0-alpha.2',
      },
      body: serializedRequest,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    if (uploadAndHeadersTimedOut || error?.name === 'AbortError') {
      throw new Error('API upload and response headers total timeout expired');
    }
    throw new Error('API request failed before a response was received');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    controller.abort();
    void response.body?.cancel().catch(() => {});
    const candidateRequestId = response.headers.get('x-request-id');
    const requestId = candidateRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(candidateRequestId)
      ? candidateRequestId
      : null;
    const suffix = requestId ? ` (request ${requestId})` : '';
    throw new Error(`API request failed with HTTP ${response.status}${suffix}`);
  }
  const body = await readBoundedJson(response, {
    maxBytes: maxResponseBytes,
    idleTimeoutMs: responseBodyIdleMs,
    totalTimeoutMs: responseBodyTotalMs,
    controller,
  });
  return validateHostedResponse(body, expected);
}
