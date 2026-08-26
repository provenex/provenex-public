/**
 * Type declarations for `@provenex/check/checkpoint`.
 *
 * Hand-authored: the runtime module is plain ESM with no build step, so the
 * code npm installs is the code you read. These declarations mirror it and
 * are checked against it by test/checkpoint-types.test.mjs.
 */

export declare const APP_CHECKPOINT_SCHEMA_VERSION: 1;
export declare const SCORE_CLOSURE_SCHEMA_VERSION: 3;
export declare const APP_DECIDE_PATH: "/api/sdk/v1/decide";

/** @deprecated Use `APP_CHECKPOINT_SCHEMA_VERSION`. */
export declare const SOLO_CHECKPOINT_SCHEMA_VERSION: 1;
/** @deprecated Use `APP_DECIDE_PATH`. */
export declare const SOLO_DECIDE_PATH: "/api/sdk/v1/decide";

export type ProvenexCheckpointMode = "observe" | "shadow" | "prevent";
export type ProvenexFailMode = "open" | "closed";
/** @deprecated Use `ProvenexCheckpointMode`. */
export type SoloCheckpointMode = ProvenexCheckpointMode;
/** @deprecated Use `ProvenexFailMode`. */
export type SoloFailMode = ProvenexFailMode;
export type GatewayAction = "allow" | "alert" | "block";
export type EffectiveAction = "allow" | "alert" | "block";
export type GatewayEvidenceStatus = "verified" | "unavailable";

/** Exact wire strings from the engine's `domain/action_context.rs`. */
export type ProtectedActionClass =
  | "secret-read"
  | "public-write"
  | "external-send"
  | "execute"
  | "deployment"
  | "database-migration"
  | "iam-mutation"
  | "financial-commitment";

/** Exact wire strings from the engine's `domain/score_closure.rs`. */
export type ScoringResourceKind =
  | "http"
  | "rpc"
  | "database"
  | "messaging"
  | "file"
  | "tool"
  | "model"
  | "agent"
  | "user-input"
  | "data-store"
  | "service"
  | "other";

export type TrustZone =
  | "untrusted-external"
  | "internal"
  | "privileged-pii"
  | "external-egress"
  | "privileged-action";

export type ReceiptKind = "intermediate" | "verdict" | "delegation";
export type EdgeKind =
  | "influence"
  | "retrieval"
  | "delegation"
  | "invocation"
  | "async-link";

export interface ScoringEdge {
  parent: string;
  kind: EdgeKind;
}

export interface ScoringResource {
  token: string;
  kind: ScoringResourceKind;
}

export interface ScoringNode {
  id: string;
  kind: ReceiptKind;
  trust_zone: TrustZone | null;
  tool_action_class?: "protected-action";
  resource: ScoringResource;
  edges: ScoringEdge[];
  timestamp: string;
  signals: Record<string, string>;
  framework_suppressed?: boolean;
}

/**
 * Exact JSON request accepted by the Engine's `POST /v1/score-closure`.
 * The caller supplies an already HMAC-minimized v3 envelope. This SDK does not
 * accept raw prompts, bodies, destinations, receipt ids, or the HMAC secret.
 */
export interface ScoreClosureRequest {
  schema_version: 3;
  customer_trust_config_digest: string;
  output_receipt_id: string;
  closure: {
    nodes: ScoringNode[];
  };
  coverage: {
    depth_reached: number;
    depth_capped: boolean;
    dangling_parent_ids: string[];
    derived_evidence_only?: boolean;
  };
  destination: {
    token: string;
    kind: ScoringResourceKind;
    trust_zone: TrustZone | null;
  };
  privacy: {
    identifier_transform: "hmac-sha256-v1";
    raw_content_removed: true;
    direct_identifiers_removed: true;
  };
}

export type EngineVerdict =
  | "policy-cleared"
  | "not-covered"
  | "undetermined"
  | "red";
export type EngineRisk = "low" | "medium" | "high" | "unknown";
export type EngineConfidence = "confirmed" | "inferred" | "suspected";

export interface VerdictProvenance {
  schema_version: number;
  evaluation_mode?: string;
  score_closure_request_digest?: string;
  score_closure_request_digest_version?: string;
  [field: string]: unknown;
}

/** Stable fields of the exact signed Engine artifact. */
export interface VerdictArtifact {
  output_receipt_id: string;
  verdict: EngineVerdict;
  risk: EngineRisk;
  confidence: EngineConfidence;
  hits: unknown[];
  coverage: unknown;
  closure_receipt_ids: string[];
  issued_at: string;
  destination?: string | null;
  provenance?: VerdictProvenance;
  [field: string]: unknown;
}

/** Exact `/v1/score-closure` response wrapper; complex projections stay open. */
export interface EgressAssessment {
  correlation_key: string;
  verdict: {
    artifact: VerdictArtifact;
    signature: string;
    key_id: string;
    artifact_canonical_json: string;
  };
  trace: unknown;
  evidence: unknown;
  provenance_escalation?: unknown;
}

/**
 * Non-authoritative labels for observability and dashboard attribution. Tenant,
 * workspace, scopes, and policy identity come only from the SDK bearer key.
 */
export interface ProvenexDecisionContext {
  connector?: string;
  operation?: string;
  labels?: Record<string, string>;
}

export interface ProvenexCheckpointRequest {
  action: {
    /** Must be the already minimized `scoreClosure.output_receipt_id`. */
    id: string;
    class: ProtectedActionClass;
  };
  scoreClosure: ScoreClosureRequest;
  context?: ProvenexDecisionContext;
}

export interface ProvenexGatewayDecision {
  schemaVersion: 1;
  decisionId: string;
  mode: ProvenexCheckpointMode;
  action: GatewayAction;
  reason: string;
  engineAssessment: EgressAssessment | null;
  evidenceStatus: GatewayEvidenceStatus;
  expiresAt?: string;
}

export interface ProvenexCheckpointResult {
  mode: ProvenexCheckpointMode;
  /** Whether the protected operation may execute now. */
  proceed: boolean;
  /** What this SDK actually did after applying its operating mode. */
  effectiveAction: EffectiveAction;
  /** True only in shadow when a verified gateway decision selected block. */
  wouldBlock: boolean;
  evidenceStatus: GatewayEvidenceStatus;
  /** Exact gateway response, including the unmodified Engine assessment. */
  gatewayDecision: ProvenexGatewayDecision | null;
  failure?: {
    kind: "timeout" | "transport" | "http" | "protocol" | "unavailable";
    reason: string;
  };
}

export interface ProvenexCheckpointOptions {
  /** Base origin of the Provenex App gateway, never the hosted Engine origin. */
  gatewayUrl: string;
  /** Tenant-scoped workload key. Engine trial keys are deliberately rejected. */
  apiKey: string;
  mode: ProvenexCheckpointMode;
  /** Defaults closed in prevent and open in observe/shadow. */
  failMode?: ProvenexFailMode;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Test/adapter seam. Production callers should leave this unset. */
  fetch?: typeof globalThis.fetch;
}

/** @deprecated Use `ProvenexDecisionContext`. */
export type SoloDecisionContext = ProvenexDecisionContext;
/** @deprecated Use `ProvenexCheckpointRequest`. */
export type SoloCheckpointRequest = ProvenexCheckpointRequest;
/** @deprecated Use `ProvenexGatewayDecision`. */
export type SoloGatewayDecision = ProvenexGatewayDecision;
/** @deprecated Use `ProvenexCheckpointResult`. */
export type SoloCheckpointResult = ProvenexCheckpointResult;
/** @deprecated Use `ProvenexCheckpointOptions`. */
export type SoloCheckpointOptions = ProvenexCheckpointOptions;

export declare class ProvenexCheckpointConfigurationError extends Error {
  name: "ProvenexCheckpointConfigurationError";
}

export declare class ProvenexBlockedError extends Error {
  name: "ProvenexBlockedError";
  readonly result: ProvenexCheckpointResult;
  constructor(message: string, result: ProvenexCheckpointResult);
}

export declare class ProvenexCheckpoint {
  readonly mode: ProvenexCheckpointMode;
  readonly failMode: ProvenexFailMode;
  readonly timeoutMs: number;
  constructor(options: ProvenexCheckpointOptions);
  decide(request: ProvenexCheckpointRequest): Promise<ProvenexCheckpointResult>;
  /** Run `operation` only when the checkpoint's effective result allows it. */
  guard<T>(
    request: ProvenexCheckpointRequest,
    operation: (result: ProvenexCheckpointResult) => T | Promise<T>,
  ): Promise<T>;
}

export declare function createProvenexCheckpoint(
  options: ProvenexCheckpointOptions,
): ProvenexCheckpoint;

/** @deprecated Use `ProvenexCheckpoint`. */
export declare const SoloCheckpoint: typeof ProvenexCheckpoint;
/** @deprecated Use `ProvenexCheckpointConfigurationError`. */
export declare const SoloCheckpointConfigurationError: typeof ProvenexCheckpointConfigurationError;
/** @deprecated Use `createProvenexCheckpoint`. */
export declare function createSoloCheckpoint(
  options: ProvenexCheckpointOptions,
): ProvenexCheckpoint;

/** Exact wire strings from the engine's tenant relation family. */
export declare const TENANT_RELATION_MARKER_PREFIX: "provenex.action_context.tenant_relation.";
export type TenantRelation = "match" | "mismatch";

/**
 * Whether the requesting subject's tenant and the touched resource's owner
 * tenant are the same application tenant. Exact string equality; resolve both
 * values from trusted state, never from caller input.
 */
export declare function tenantRelation(
  subjectTenant: string,
  resourceTenant: string,
): TenantRelation;

/** The signal key a deployed tenant-match rule reads, keyed by its rule id. */
export declare function tenantRelationMarkerKey(ruleId: string): string;

/**
 * The one Tenant Guard fact that may enter `closure.nodes[].signals`: whether
 * the two trusted tenant stamps were equal, keyed by the deployed rule's id.
 */
export declare function tenantRelationMarker(
  ruleId: string,
  subjectTenant: string,
  resourceTenant: string,
): { key: string; value: TenantRelation };
