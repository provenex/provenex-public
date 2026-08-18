export const CHECK_DATA_POLICY = Object.freeze({
  schema_version: 'provenex-check-retention-policy.v1',
  policy_id: 'provenex-check-ephemeral-v1',
  scope: 'provenex-check-application',
  raw_evidence_retention_seconds: 0,
  derived_results_retention_seconds: 0,
  workspace_lifecycle: 'request-only',
  workspace_deleted_before_response: true,
  policy_url: 'https://github.com/provenex/provenex-public/blob/main/docs/provenex-check-data-policy.md',
});

export function matchesCheckDataPolicy(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const expectedKeys = Object.keys(CHECK_DATA_POLICY).sort();
  const actualKeys = Object.keys(candidate).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  if (!actualKeys.every((key, index) => key === expectedKeys[index])) return false;
  return expectedKeys.every((key) => candidate[key] === CHECK_DATA_POLICY[key]);
}
