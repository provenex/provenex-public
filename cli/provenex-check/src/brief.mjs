// A thin view over the App gateway's server-authored owner brief. The CLI
// validates and renders the DTO; it does not decide what is risky, healthy, or
// worth the owner's attention.

import {
  fetchAppJson,
  plainRecord,
  safeIdentifier,
  safeText,
  safeTimestamp,
} from './app-client.mjs';
import { UsageError } from './errors.mjs';

const STATUSES = new Set(['needs-attention', 'setup-needed', 'no-action']);
const HEALTH_STATES = new Set([
  'working',
  'needs-attention',
  'setup-needed',
  'not-checked-here',
  'not-fully-checked',
]);
const PRIORITIES = new Set(['now', 'next']);
const CATEGORIES = new Set(['held-actions', 'action-outcomes', 'connections', 'setup']);
const APP_PATHS = new Set(['/overview', '/connections', '/guardrails', '/findings']);

function member(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new UsageError(`the gateway returned an invalid ${label}`);
  }
  return value;
}

export function validateBrief(value) {
  if (
    !plainRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.health)
    || value.health.length > 12
    || !Array.isArray(value.actions)
    || value.actions.length > 10
  ) {
    throw new UsageError('the gateway returned an unsupported brief schema');
  }

  const healthIds = new Set();
  const health = value.health.map((area) => {
    if (!plainRecord(area)) throw new UsageError('the gateway returned an invalid health area');
    const id = safeIdentifier(area.id, 'health id');
    if (healthIds.has(id)) throw new UsageError('the gateway returned a duplicate health area');
    healthIds.add(id);
    return {
      id,
      label: safeText(area.label, 'health label', { maximum: 96 }),
      state: member(area.state, HEALTH_STATES, 'health state'),
      summary: safeText(area.summary, 'health summary', { maximum: 512 }),
    };
  });

  const actionIds = new Set();
  const actions = value.actions.map((action) => {
    if (!plainRecord(action)) throw new UsageError('the gateway returned an invalid action');
    const id = safeIdentifier(action.id, 'action id');
    if (actionIds.has(id)) throw new UsageError('the gateway returned a duplicate action');
    actionIds.add(id);
    return {
      id,
      priority: member(action.priority, PRIORITIES, 'action priority'),
      category: member(action.category, CATEGORIES, 'action category'),
      title: safeText(action.title, 'action title', { maximum: 160 }),
      why: safeText(action.why, 'action reason', { maximum: 512 }),
      nextStep: safeText(action.nextStep, 'action next step', { maximum: 512 }),
      appPath: member(action.appPath, APP_PATHS, 'action App path'),
    };
  });
  const expectedStatus = actions.some((action) => action.priority === 'now')
    ? 'needs-attention'
    : actions.length > 0
      ? 'setup-needed'
      : 'no-action';
  const status = member(value.status, STATUSES, 'brief status');
  if (status !== expectedStatus) {
    throw new UsageError('the gateway returned contradictory brief status and actions');
  }

  return {
    schemaVersion: 1,
    generatedAt: safeTimestamp(value.generatedAt, 'brief timestamp'),
    workspaceId: safeIdentifier(value.workspaceId, 'workspace id'),
    status,
    headline: safeText(value.headline, 'brief headline', { maximum: 192 }),
    health,
    actions,
    honesty: safeText(value.honesty, 'brief coverage note', { maximum: 768 }),
  };
}

function renderActionGroup(title, actions) {
  if (actions.length === 0) return [];
  const lines = [title];
  actions.forEach((action, index) => {
    lines.push(`${index + 1}. ${action.title}`);
    lines.push(`   Why: ${action.why}`);
    lines.push(`   Next: ${action.nextStep}`);
    lines.push(`   Open: ${action.appPath}`);
  });
  lines.push('');
  return lines;
}

export function renderBriefText(brief) {
  const now = brief.actions.filter((action) => action.priority === 'now');
  const next = brief.actions.filter((action) => action.priority === 'next');
  const lines = [
    `Provenex brief: ${brief.headline}`,
    `Workspace ${brief.workspaceId} · ${brief.generatedAt}`,
    '',
    ...renderActionGroup('Do now', now),
    ...renderActionGroup('Do next', next),
  ];
  if (brief.actions.length === 0) {
    lines.push('No action was produced from the areas evaluated by this brief.', '');
  }
  lines.push(`Coverage note: ${brief.honesty}`);
  return `${lines.join('\n')}\n`;
}

export async function renderBrief(
  gatewayUrl,
  { format = 'text', env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const body = await fetchAppJson(gatewayUrl, '/api/sdk/v1/brief', { env, fetchImpl });
  const brief = validateBrief(body);
  return format === 'json'
    ? `${JSON.stringify(brief, null, 2)}\n`
    : renderBriefText(brief);
}
