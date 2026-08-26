/**
 * Provenex App Action Checkpoint (runtime half of `@provenex/check`).
 *
 * This module talks only to the tenant-scoped Provenex App gateway. The
 * gateway owns the hosted Engine credential, verifies the signed assessment,
 * applies the configured PEP policy, and returns a separately named
 * checkpoint decision. The SDK never calls the hosted scorer directly and
 * never attempts to infer an action from `verdict.artifact.verdict` by
 * itself.
 *
 * Unlike the CLI half of this package, which a person runs once with a
 * consent prompt, this module lives inside your application's request path.
 * It has one bounded timeout, no retry, no redirect, no cache, and it holds
 * a tenant-scoped `pvx_sdk_` workload key. Import it as
 * `@provenex/check/checkpoint`; nothing here is loaded by the CLI.
 */

export const APP_CHECKPOINT_SCHEMA_VERSION = 1;
export const SCORE_CLOSURE_SCHEMA_VERSION = 3;
export const APP_DECIDE_PATH = "/api/sdk/v1/decide";

/** @deprecated Use `APP_CHECKPOINT_SCHEMA_VERSION`. */
export const SOLO_CHECKPOINT_SCHEMA_VERSION = APP_CHECKPOINT_SCHEMA_VERSION;
/** @deprecated Use `APP_DECIDE_PATH`. */
export const SOLO_DECIDE_PATH = APP_DECIDE_PATH;

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_LABELS = 16;
const MAX_CONTEXT_VALUE_BYTES = 256;
const HMAC_TOKEN = /^hmac-sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SDK_KEY = /^pvx_sdk_[A-Za-z0-9_-]{8,}$/;
const PROTECTED_ACTION_CLASSES = new Set([
  "secret-read",
  "public-write",
  "external-send",
  "execute",
  "deployment",
  "database-migration",
  "iam-mutation",
  "financial-commitment",
]);
const MODES = new Set(["observe", "shadow", "prevent"]);
const GATEWAY_ACTIONS = new Set(["allow", "alert", "block"]);

export class ProvenexCheckpointConfigurationError extends Error {
  name = "ProvenexCheckpointConfigurationError";
}

export class ProvenexBlockedError extends Error {
  name = "ProvenexBlockedError";

  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

class GatewayProtocolError extends Error {}

export class ProvenexCheckpoint {
  #endpoint;
  #apiKey;
  #maxResponseBytes;
  #fetch;

  constructor(options) {
    if (!MODES.has(options.mode)) {
      throw new ProvenexCheckpointConfigurationError("mode must be observe, shadow, or prevent");
    }
    this.mode = options.mode;
    this.failMode = options.failMode ?? (options.mode === "prevent" ? "closed" : "open");
    if (this.failMode !== "open" && this.failMode !== "closed") {
      throw new ProvenexCheckpointConfigurationError("failMode must be open or closed");
    }
    // The pairing is not a preference, it is the gateway's registration rule:
    // a workload key is refused registration unless fail_mode is `closed` for
    // prevent and `open` otherwise, and every decide call re-checks the wire
    // failMode against that registration. So an unpaired client is rejected
    // with HTTP 400 on 100% of requests, forever.
    //
    // Validating each field alone let that construct. In prevent mode the 400
    // arrives as a transport failure, and the failure path only withholds when
    // failMode is `closed`, so a checkpoint built as prevent + open ran the
    // protected side effect every single time while recording no decision at
    // all. Failing here, loudly, at construction, is the only place this can be
    // caught before it is silently doing nothing in production.
    const requiredFailMode = options.mode === "prevent" ? "closed" : "open";
    if (this.failMode !== requiredFailMode) {
      throw new ProvenexCheckpointConfigurationError(
        `${options.mode} mode requires failMode "${requiredFailMode}"; the gateway rejects any other pairing`,
      );
    }
    if (!SDK_KEY.test(options.apiKey)) {
      throw new ProvenexCheckpointConfigurationError(
        "apiKey must be a tenant-scoped pvx_sdk_ workload key; Engine trial keys are not accepted",
      );
    }
    this.#apiKey = options.apiKey;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 50, 30_000, "timeoutMs");
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.#endpoint = appGatewayEndpoint(options.gatewayUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new ProvenexCheckpointConfigurationError("this runtime does not provide fetch");
    }
  }

  async decide(request) {
    validateRequest(request);
    const body = {
      schemaVersion: APP_CHECKPOINT_SCHEMA_VERSION,
      mode: this.mode,
      failMode: this.failMode,
      action: request.action,
      ...(request.context ? { context: request.context } : {}),
      scoreClosure: request.scoreClosure,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return this.#failure("http", `Provenex App gateway returned HTTP ${response.status}`);
      }
      const raw = await readBoundedBody(response, this.#maxResponseBytes);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new GatewayProtocolError("Provenex App gateway response was not valid JSON");
      }
      const decision = parseGatewayDecision(parsed, this.mode);
      if (decision.evidenceStatus === "unavailable") {
        return this.#failure("unavailable", decision.reason, decision);
      }
      return applyOperatingMode(this.mode, decision);
    } catch (error) {
      if (isAbort(error)) {
        return this.#failure("timeout", `Provenex App gateway exceeded the ${this.timeoutMs}ms budget`);
      }
      if (error instanceof GatewayProtocolError) {
        return this.#failure("protocol", error.message);
      }
      return this.#failure("transport", "Provenex App gateway request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run `operation` only when the checkpoint's effective result allows it. */
  async guard(request, operation) {
    const result = await this.decide(request);
    if (!result.proceed) {
      throw new ProvenexBlockedError(
        result.gatewayDecision?.reason ?? result.failure?.reason ?? "Provenex blocked the action",
        result,
      );
    }
    return operation(result);
  }

  #failure(kind, reason, gatewayDecision = null) {
    // Observe and shadow never withhold. Closed failure posture becomes an
    // actual stop only at a prevent checkpoint.
    const block = this.mode === "prevent" && this.failMode === "closed";
    return {
      mode: this.mode,
      proceed: !block,
      effectiveAction: block ? "block" : "alert",
      wouldBlock: false,
      evidenceStatus: "unavailable",
      gatewayDecision,
      failure: { kind, reason },
    };
  }
}

export function createProvenexCheckpoint(options) {
  return new ProvenexCheckpoint(options);
}

/** @deprecated Use `ProvenexCheckpoint`. */
export { ProvenexCheckpoint as SoloCheckpoint };
/** @deprecated Use `ProvenexCheckpointConfigurationError`. */
export { ProvenexCheckpointConfigurationError as SoloCheckpointConfigurationError };
/** @deprecated Use `createProvenexCheckpoint`. */
export function createSoloCheckpoint(options) {
  return createProvenexCheckpoint(options);
}

/** Exact wire strings from the engine's tenant relation family. */
export const TENANT_RELATION_MARKER_PREFIX = "provenex.action_context.tenant_relation.";

const ACTION_RULE_ID = /^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$/;
const MAX_TENANT_VALUE_BYTES = 128;

function assertTenantValue(field, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > MAX_TENANT_VALUE_BYTES ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    throw new ProvenexCheckpointConfigurationError(
      `${field} must be a non-empty tenant identifier of at most ${MAX_TENANT_VALUE_BYTES} UTF-8 bytes with no whitespace or control characters`,
    );
  }
}

/**
 * Whether the requesting subject's tenant and the touched resource's owner
 * tenant are the same application tenant. EXACT string equality, matching the
 * engine: any normalization could merge two distinct tenants, which fails
 * open on the one comparison this family exists for. Resolve BOTH values from
 * trusted state (the session and the row), never from caller input.
 */
export function tenantRelation(subjectTenant, resourceTenant) {
  assertTenantValue("subjectTenant", subjectTenant);
  assertTenantValue("resourceTenant", resourceTenant);
  return subjectTenant === resourceTenant ? "match" : "mismatch";
}

/** The signal key a deployed tenant-match rule reads, keyed by its rule id. */
export function tenantRelationMarkerKey(ruleId) {
  if (typeof ruleId !== "string" || !ACTION_RULE_ID.test(ruleId)) {
    throw new ProvenexCheckpointConfigurationError(
      "ruleId must be 1-128 lowercase letters, digits, or hyphens and may not start or end with a hyphen",
    );
  }
  return `${TENANT_RELATION_MARKER_PREFIX}${ruleId}`;
}

/**
 * The one Tenant Guard fact that may enter `closure.nodes[].signals`: whether
 * the two trusted tenant stamps were equal, keyed by the deployed rule's id.
 * Neither tenant identifier belongs in the envelope; this helper computes the
 * comparison locally and returns only the closed two-word relation.
 */
export function tenantRelationMarker(ruleId, subjectTenant, resourceTenant) {
  return {
    key: tenantRelationMarkerKey(ruleId),
    value: tenantRelation(subjectTenant, resourceTenant),
  };
}

function applyOperatingMode(mode, decision) {
  if (mode === "prevent") {
    return {
      mode,
      proceed: decision.action !== "block",
      effectiveAction: decision.action,
      wouldBlock: false,
      evidenceStatus: "verified",
      gatewayDecision: decision,
    };
  }
  if (mode === "shadow" && decision.action === "block") {
    return {
      mode,
      proceed: true,
      effectiveAction: "alert",
      wouldBlock: true,
      evidenceStatus: "verified",
      gatewayDecision: decision,
    };
  }
  return {
    mode,
    proceed: true,
    effectiveAction: decision.action === "block" ? "alert" : decision.action,
    wouldBlock: false,
    evidenceStatus: "verified",
    gatewayDecision: decision,
  };
}

function appGatewayEndpoint(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new ProvenexCheckpointConfigurationError("gatewayUrl must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProvenexCheckpointConfigurationError("gatewayUrl must not contain credentials, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new ProvenexCheckpointConfigurationError("gatewayUrl must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.hostname === "provenex-verdict.fly.dev") {
    throw new ProvenexCheckpointConfigurationError(
      "gatewayUrl must be the Provenex App gateway, not the hosted Fly Engine",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ProvenexCheckpointConfigurationError("gatewayUrl must be a base origin without an API path");
  }
  url.pathname = APP_DECIDE_PATH;
  return url;
}

function boundedInteger(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProvenexCheckpointConfigurationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new ProvenexCheckpointConfigurationError("checkpoint request is required");
  }
  if (!request.action || !PROTECTED_ACTION_CLASSES.has(request.action.class)) {
    throw new ProvenexCheckpointConfigurationError("action.class is not a supported protected action class");
  }
  const closure = request.scoreClosure;
  if (!closure || closure.schema_version !== SCORE_CLOSURE_SCHEMA_VERSION) {
    throw new ProvenexCheckpointConfigurationError("scoreClosure must use score-closure schema_version 3");
  }
  if (!HMAC_TOKEN.test(closure.output_receipt_id) || request.action.id !== closure.output_receipt_id) {
    throw new ProvenexCheckpointConfigurationError(
      "action.id must equal the HMAC-minimized scoreClosure.output_receipt_id",
    );
  }
  if (!SHA256.test(closure.customer_trust_config_digest)) {
    throw new ProvenexCheckpointConfigurationError(
      "scoreClosure.customer_trust_config_digest must be a lowercase SHA-256 digest",
    );
  }
  if (!HMAC_TOKEN.test(closure.destination.token)) {
    throw new ProvenexCheckpointConfigurationError("scoreClosure.destination.token must be HMAC-minimized");
  }
  if (
    closure.privacy.identifier_transform !== "hmac-sha256-v1" ||
    closure.privacy.raw_content_removed !== true ||
    closure.privacy.direct_identifiers_removed !== true
  ) {
    throw new ProvenexCheckpointConfigurationError("scoreClosure privacy attestation is incomplete");
  }
  if (!Array.isArray(closure.closure.nodes) || closure.closure.nodes.length === 0 || closure.closure.nodes.length > 512) {
    throw new ProvenexCheckpointConfigurationError("scoreClosure must contain 1 to 512 minimized nodes");
  }
  for (const node of closure.closure.nodes) {
    if (!HMAC_TOKEN.test(node.id) || !HMAC_TOKEN.test(node.resource.token)) {
      throw new ProvenexCheckpointConfigurationError("scoreClosure node ids and resources must be HMAC-minimized");
    }
    for (const edge of node.edges) {
      if (!HMAC_TOKEN.test(edge.parent)) {
        throw new ProvenexCheckpointConfigurationError("scoreClosure edge parents must be HMAC-minimized");
      }
    }
  }
  validateContext(request.context);
}

function validateContext(context) {
  if (!context) return;
  for (const [field, value] of [
    ["context.connector", context.connector],
    ["context.operation", context.operation],
  ]) {
    if (value !== undefined && (!value || byteLength(value) > MAX_CONTEXT_VALUE_BYTES)) {
      throw new ProvenexCheckpointConfigurationError(`${field} must be 1 to ${MAX_CONTEXT_VALUE_BYTES} UTF-8 bytes`);
    }
  }
  const labels = context.labels ?? {};
  const entries = Object.entries(labels);
  if (entries.length > MAX_CONTEXT_LABELS) {
    throw new ProvenexCheckpointConfigurationError(`context.labels may contain at most ${MAX_CONTEXT_LABELS} entries`);
  }
  for (const [key, value] of entries) {
    if (!key || byteLength(key) > 64 || typeof value !== "string" || byteLength(value) > MAX_CONTEXT_VALUE_BYTES) {
      throw new ProvenexCheckpointConfigurationError("context label keys or values exceeded their bounds");
    }
  }
}

function parseGatewayDecision(value, requestedMode) {
  if (!isRecord(value)) throw new GatewayProtocolError("Provenex App gateway response must be an object");
  if (value.schemaVersion !== APP_CHECKPOINT_SCHEMA_VERSION) {
    throw new GatewayProtocolError("Provenex App gateway response used an unsupported schemaVersion");
  }
  if (value.mode !== requestedMode || !MODES.has(value.mode)) {
    throw new GatewayProtocolError("Provenex App gateway response mode did not match the request");
  }
  if (typeof value.decisionId !== "string" || !value.decisionId) {
    throw new GatewayProtocolError("Provenex App gateway response omitted decisionId");
  }
  if (!GATEWAY_ACTIONS.has(value.action)) {
    throw new GatewayProtocolError("Provenex App gateway response contained an unknown action");
  }
  if (typeof value.reason !== "string" || !value.reason) {
    throw new GatewayProtocolError("Provenex App gateway response omitted reason");
  }
  if (value.evidenceStatus !== "verified" && value.evidenceStatus !== "unavailable") {
    throw new GatewayProtocolError("Provenex App gateway response contained an unknown evidenceStatus");
  }
  if (value.evidenceStatus === "verified") {
    validateEngineAssessment(value.engineAssessment);
  } else if (value.engineAssessment !== null) {
    throw new GatewayProtocolError("an unavailable decision must not contain a forged Engine assessment");
  }
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new GatewayProtocolError("Provenex App gateway response contained an invalid expiresAt");
    }
    if (Date.parse(value.expiresAt) <= Date.now()) {
      throw new GatewayProtocolError("Provenex App gateway decision was already expired");
    }
  }
  return value;
}

function validateEngineAssessment(value) {
  if (!isRecord(value) || typeof value.correlation_key !== "string") {
    throw new GatewayProtocolError("verified decision omitted the Engine assessment");
  }
  const signed = value.verdict;
  if (!isRecord(signed) || typeof signed.key_id !== "string" || typeof signed.signature !== "string") {
    throw new GatewayProtocolError("Engine assessment omitted its signed verdict wrapper");
  }
  if (typeof signed.artifact_canonical_json !== "string" || signed.artifact_canonical_json.length === 0) {
    throw new GatewayProtocolError("Engine assessment omitted authoritative signed artifact bytes");
  }
  const artifact = signed.artifact;
  if (
    !isRecord(artifact) ||
    typeof artifact.output_receipt_id !== "string" ||
    !["policy-cleared", "not-covered", "undetermined", "red"].includes(String(artifact.verdict)) ||
    !["low", "medium", "high", "unknown"].includes(String(artifact.risk)) ||
    !["confirmed", "inferred", "suspected"].includes(String(artifact.confidence))
  ) {
    throw new GatewayProtocolError("Engine assessment artifact did not match the score-closure contract");
  }
}

async function readBoundedBody(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new GatewayProtocolError(`Provenex App gateway response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayProtocolError(`Provenex App gateway response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}
