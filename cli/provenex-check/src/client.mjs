import { homedir } from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { UsageError } from './errors.mjs';
import { validateHostedResponse } from './report.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new UsageError('API URL must use HTTPS (HTTP is allowed only for loopback testing)');
  }
  return url.origin;
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(homedir(), '.config');
  return path.join(base, 'provenex', 'check.json');
}

export async function loadApiKey() {
  if (process.env.PROVENEX_API_KEY) return process.env.PROVENEX_API_KEY;
  const file = configPath();
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

async function readBoundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) throw new Error('API returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
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

export async function submitRun({ origin, apiKey, serializedRequest, expected, timeoutMs = 60_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(new URL('/v1/check/runs', origin), {
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
    if (error?.name === 'AbortError') throw new Error('API request timed out');
    throw new Error('API request failed before a response was received');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const candidateRequestId = response.headers.get('x-request-id');
    const requestId = candidateRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(candidateRequestId)
      ? candidateRequestId
      : null;
    const suffix = requestId ? ` (request ${requestId})` : '';
    throw new Error(`API request failed with HTTP ${response.status}${suffix}`);
  }
  const body = await readBoundedJson(response);
  return validateHostedResponse(body, expected);
}
