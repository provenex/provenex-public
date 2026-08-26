import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_CHECKPOINT_SCHEMA_VERSION,
  APP_DECIDE_PATH,
  createProvenexCheckpoint,
  createSoloCheckpoint,
  ProvenexBlockedError,
  ProvenexCheckpoint,
  ProvenexCheckpointConfigurationError,
  SoloCheckpoint,
  SoloCheckpointConfigurationError,
  TENANT_RELATION_MARKER_PREFIX,
  tenantRelation,
  tenantRelationMarker,
  tenantRelationMarkerKey,
} from "../src/checkpoint.mjs";

const token = (digit) => `hmac-sha256:${digit.repeat(64)}`;

const closure = {
  schema_version: 3,
  customer_trust_config_digest: "a".repeat(64),
  output_receipt_id: token("1"),
  closure: {
    nodes: [
      {
        id: token("1"),
        kind: "intermediate",
        trust_zone: "privileged-action",
        tool_action_class: "protected-action",
        resource: { token: token("2"), kind: "tool" },
        edges: [],
        timestamp: "2026-08-20T20:00:00Z",
        signals: {
          "provenex.action.context.protected": "true",
          "provenex.action.context.class": "financial-commitment",
        },
      },
    ],
  },
  coverage: {
    depth_reached: 1,
    depth_capped: false,
    dangling_parent_ids: [],
  },
  destination: {
    token: token("3"),
    kind: "service",
    trust_zone: "privileged-action",
  },
  privacy: {
    identifier_transform: "hmac-sha256-v1",
    raw_content_removed: true,
    direct_identifiers_removed: true,
  },
};

const assessment = {
  correlation_key: token("1"),
  verdict: {
    artifact: {
      output_receipt_id: token("1"),
      verdict: "red",
      risk: "high",
      confidence: "confirmed",
      hits: [],
      coverage: {},
      closure_receipt_ids: [token("1")],
      issued_at: "2026-08-20T20:00:00Z",
      destination: token("3"),
    },
    signature: "ab".repeat(64),
    key_id: "tenant-key-1",
    artifact_canonical_json: "7b7d",
  },
  trace: {},
  evidence: { band: "observed" },
};

const request = {
  action: { id: closure.output_receipt_id, class: "financial-commitment" },
  context: {
    connector: "stripe",
    operation: "refund.create",
    labels: { integration: "brightcart" },
  },
  scoreClosure: closure,
};

function gatewayDecision(mode, action) {
  return {
    schemaVersion: 1,
    decisionId: "dec_01",
    mode,
    action,
    reason: action === "block" ? "configured policy selected block" : "configured policy allowed",
    engineAssessment: assessment,
    evidenceStatus: "verified",
    expiresAt: "2099-08-20T20:00:10Z",
  };
}

function jsonFetch(body, capture) {
  return async (input, init) => {
    if (capture) Object.assign(capture, { input: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function checkpoint(mode, fetchImpl, failMode) {
  return new ProvenexCheckpoint({
    gatewayUrl: "https://app-sandbox.provenex.ai",
    apiKey: "pvx_sdk_test_workload_key",
    mode,
    failMode,
    fetch: fetchImpl,
  });
}

test("sends the exact minimized closure only to the Provenex App gateway", async () => {
  const capture = {};
  const result = await checkpoint("prevent", jsonFetch(gatewayDecision("prevent", "allow"), capture)).decide(request);
  assert.equal(capture.input, "https://app-sandbox.provenex.ai/api/sdk/v1/decide");
  const init = capture.init;
  assert.equal(init.headers.authorization, "Bearer pvx_sdk_test_workload_key");
  const sent = JSON.parse(String(init.body));
  assert.deepEqual(sent.scoreClosure, closure);
  assert.deepEqual(sent.context, request.context);
  assert.equal(sent.mode, "prevent");
  assert.equal(sent.failMode, "closed", "prevent defaults fail closed");
  assert.equal("tenantId" in sent, false, "tenant authority must come from the SDK key");
  assert.deepEqual(result.gatewayDecision?.engineAssessment, assessment);
});

test("prevent with a verified block withholds the operation", async () => {
  let called = false;
  const client = checkpoint("prevent", jsonFetch(gatewayDecision("prevent", "block")));
  await assert.rejects(
    client.guard(request, () => {
      called = true;
    }),
    (error) => error instanceof ProvenexBlockedError && error.result.effectiveAction === "block",
  );
  assert.equal(called, false);
});

test("shadow records a verified would-block but still runs", async () => {
  const client = checkpoint("shadow", jsonFetch(gatewayDecision("shadow", "block")));
  const result = await client.decide(request);
  assert.equal(result.proceed, true);
  assert.equal(result.effectiveAction, "alert");
  assert.equal(result.wouldBlock, true);
  assert.equal(result.gatewayDecision?.action, "block");
});

test("observe never upgrades a returned block into a prevention claim", async () => {
  const result = await checkpoint("observe", jsonFetch(gatewayDecision("observe", "block"))).decide(request);
  assert.equal(result.proceed, true);
  assert.equal(result.effectiveAction, "alert");
  assert.equal(result.wouldBlock, false);
});

test("prevent timeout follows the closed default and carries no assessment", async () => {
  const never = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const client = new ProvenexCheckpoint({
    gatewayUrl: "http://127.0.0.1:8787",
    apiKey: "pvx_sdk_test_workload_key",
    mode: "prevent",
    timeoutMs: 50,
    fetch: never,
  });
  const result = await client.decide(request);
  assert.equal(result.proceed, false);
  assert.equal(result.effectiveAction, "block");
  assert.equal(result.evidenceStatus, "unavailable");
  assert.equal(result.gatewayDecision, null);
  assert.equal(result.failure?.kind, "timeout");
});

// This previously asserted that prevent + failMode "open" was a supported
// configuration that permits on transport failure. It is not supported: the
// gateway refuses to register a workload key whose fail_mode is not `closed`
// for prevent, and re-checks the wire failMode against that registration on
// every decide, so such a client receives HTTP 400 on 100% of requests. The
// SDK then mapped that 400 to a failure that does not withhold, so the
// checkpoint silently ran the protected side effect forever while recording
// nothing. The pairing is now refused at construction, and this pins that.
test("refuses a mode and failMode pairing the gateway would reject on every call", () => {
  const broken = async () => {
    throw new TypeError("connection refused");
  };
  assert.throws(
    () => checkpoint("prevent", broken, "open"),
    /prevent mode requires failMode "closed"/,
  );
  for (const mode of ["observe", "shadow"]) {
    assert.throws(
      () => checkpoint(mode, broken, "closed"),
      /requires failMode "open"/,
      `${mode} + closed must be refused, not silently accepted`,
    );
  }
  // The paired forms still construct.
  assert.ok(checkpoint("prevent", broken, "closed"));
  assert.ok(checkpoint("observe", broken, "open"));
  assert.ok(checkpoint("shadow", broken, "open"));
  // ...and so does omitting failMode entirely, which is the documented path.
  assert.ok(checkpoint("prevent", broken));
  assert.ok(checkpoint("observe", broken));
});

test("explicit gateway unavailable response is handled through local fail posture", async () => {
  const unavailable = {
    schemaVersion: 1,
    decisionId: "dec_unavailable",
    mode: "prevent",
    action: "block",
    reason: "Engine decision service unavailable",
    engineAssessment: null,
    evidenceStatus: "unavailable",
  };
  const result = await checkpoint("prevent", jsonFetch(unavailable)).decide(request);
  assert.equal(result.proceed, false);
  assert.equal(result.gatewayDecision?.engineAssessment, null);
  assert.equal(result.failure?.kind, "unavailable");
});

test("malformed verified assessment fails closed in prevent", async () => {
  const malformed = {
    ...gatewayDecision("prevent", "allow"),
    engineAssessment: { correlation_key: "x" },
  };
  const result = await checkpoint("prevent", jsonFetch(malformed)).decide(request);
  assert.equal(result.proceed, false);
  assert.equal(result.failure?.kind, "protocol");
});

test("rejects the direct Fly scorer and trial credentials", () => {
  assert.throws(
    () =>
      new ProvenexCheckpoint({
        gatewayUrl: "https://provenex-verdict.fly.dev",
        apiKey: "pvx_sdk_test_workload_key",
        mode: "observe",
      }),
    ProvenexCheckpointConfigurationError,
  );
  assert.throws(
    () =>
      new ProvenexCheckpoint({
        gatewayUrl: "https://app-sandbox.provenex.ai",
        apiKey: "pvx_trial_not_allowed_here",
        mode: "observe",
      }),
    ProvenexCheckpointConfigurationError,
  );
});

test("rejects raw action identities that are not the minimized output token", async () => {
  const client = checkpoint("observe", jsonFetch(gatewayDecision("observe", "allow")));
  await assert.rejects(
    client.decide({ ...request, action: { ...request.action, id: "refund_123" } }),
    ProvenexCheckpointConfigurationError,
  );
});

test("keeps deprecated Solo symbols as exact compatibility aliases", () => {
  assert.equal(SoloCheckpoint, ProvenexCheckpoint);
  assert.equal(SoloCheckpointConfigurationError, ProvenexCheckpointConfigurationError);
  assert.equal(APP_CHECKPOINT_SCHEMA_VERSION, 1);
  assert.equal(APP_DECIDE_PATH, "/api/sdk/v1/decide");

  const options = {
    gatewayUrl: "https://app-sandbox.provenex.ai",
    apiKey: "pvx_sdk_test_workload_key",
    mode: "observe",
    fetch: jsonFetch(gatewayDecision("observe", "allow")),
  };
  assert.ok(createProvenexCheckpoint(options) instanceof ProvenexCheckpoint);
  assert.ok(createSoloCheckpoint(options) instanceof ProvenexCheckpoint);
});

test("tenant relation helpers mirror the engine wire exactly and never leak identifiers", () => {
  assert.equal(TENANT_RELATION_MARKER_PREFIX, "provenex.action_context.tenant_relation.");
  assert.equal(tenantRelation("acct-alpha", "acct-alpha"), "match");
  assert.equal(tenantRelation("acct-alpha", "acct-beta"), "mismatch");
  // Exact bytes: case variants are DIFFERENT tenants, matching the engine.
  assert.equal(tenantRelation("Acct-Alpha", "acct-alpha"), "mismatch");

  const marker = tenantRelationMarker("export-tenant-binding", "acct-alpha", "acct-beta");
  assert.equal(marker.key, "provenex.action_context.tenant_relation.export-tenant-binding");
  assert.equal(marker.value, "mismatch");
  // The marker carries no identifier from either side.
  assert.ok(!marker.key.includes("acct-alpha") && !`${marker.value}`.includes("acct"));

  for (const bad of ["", " acct-alpha", "acct alpha", "acct\talpha", "x".repeat(129)]) {
    assert.throws(() => tenantRelation(bad, "acct-alpha"), ProvenexCheckpointConfigurationError);
    assert.throws(() => tenantRelation("acct-alpha", bad), ProvenexCheckpointConfigurationError);
  }
  for (const bad of ["", "BAD-ID", "-leading", "trailing-", "has space", "Upper"]) {
    assert.throws(() => tenantRelationMarkerKey(bad), ProvenexCheckpointConfigurationError);
  }
});

test("the CLI never loads the checkpoint module", async () => {
  // The CLI half is a one-shot consented collector; the checkpoint half holds
  // a workload key and lives in a request path. Keeping the import graphs
  // disjoint is part of the package's custody story: `npx @provenex/check`
  // must not execute runtime-checkpoint code, and importing the checkpoint
  // must not pull in the collector.
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const srcDir = new URL("../src/", import.meta.url).pathname;
  for (const file of await readdir(srcDir)) {
    if (file === "checkpoint.mjs") continue;
    const body = await readFile(join(srcDir, file), "utf8");
    assert.ok(
      !body.includes("checkpoint.mjs"),
      `${file} must not import the runtime checkpoint module`,
    );
  }
  const checkpointBody = await readFile(join(srcDir, "checkpoint.mjs"), "utf8");
  assert.ok(
    !/from ["']\.\/(?!checkpoint)/.test(checkpointBody),
    "checkpoint.mjs must not import CLI modules",
  );
});
