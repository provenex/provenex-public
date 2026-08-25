import { opendir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  inspectAiHistory,
  resolveScanRoot,
  targetLabelForRoot,
} from './collector.mjs';

const LANGUAGE_BY_EXT = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.php': 'PHP',
  '.cs': 'C#',
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.h': 'C/C++',
  '.hpp': 'C++',
  '.m': 'Objective-C',
  '.mm': 'Objective-C++',
  '.dart': 'Dart',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
};

const MAX_ENTRIES = 20_000;
const MAX_DIRECTORIES = 4_000;

async function inventory(root) {
  const languages = new Map();
  const hits = {
    workflows: 0,
    iac: 0,
    mcp: 0,
    agentDocs: 0,
    envFiles: 0,
    fly: false,
    vercel: false,
    supabase: false,
    otelFiles: [],
  };
  let entries = 0;
  let directories = 0;
  const excluded = new Set(DEFAULT_EXCLUDED_DIRECTORIES);

  async function visit(directory) {
    directories += 1;
    if (directories > MAX_DIRECTORIES || entries > MAX_ENTRIES) return;
    let listing;
    try {
      listing = await opendir(directory);
    } catch {
      return;
    }
    for await (const entry of listing) {
      entries += 1;
      if (entries > MAX_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const lower = relative.toLowerCase();
      const name = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(name);
      if (LANGUAGE_BY_EXT[ext]) {
        languages.set(LANGUAGE_BY_EXT[ext], (languages.get(LANGUAGE_BY_EXT[ext]) || 0) + 1);
      }
      if (lower.includes('.github/workflows/') && (name.endsWith('.yml') || name.endsWith('.yaml'))) {
        hits.workflows += 1;
      }
      if (
        name.endsWith('.tf')
        || name === 'dockerfile'
        || name === 'containerfile'
        || name === 'fly.toml'
        || name === 'serverless.yml'
      ) {
        hits.iac += 1;
      }
      if (name === 'mcp.json' || name.endsWith('.mcp.json') || lower.includes('.cursor/mcp')) {
        hits.mcp += 1;
      }
      if (
        name === 'agents.md'
        || name === 'claude.md'
        || name === '.cursorrules'
        || name.endsWith('.mdc')
      ) {
        hits.agentDocs += 1;
      }
      if (name === '.env' || name.startsWith('.env.') || name === '.envrc' || name === '.dev.vars') {
        hits.envFiles += 1;
      }
      if (name === 'fly.toml' || lower.includes('fly.io')) hits.fly = true;
      if (name === 'vercel.json' || name === '.vercel') hits.vercel = true;
      if (name === 'supabase' || lower.includes('supabase/')) hits.supabase = true;
      if (
        (name.includes('otel') || name.includes('otlp') || name.includes('trace'))
        && (name.endsWith('.json') || name.endsWith('.jsonl'))
        && hits.otelFiles.length < 8
      ) {
        hits.otelFiles.push(relative);
      }
    }
  }

  await visit(root);
  return { languages, hits, truncated: entries > MAX_ENTRIES || directories > MAX_DIRECTORIES };
}

export function renderCapabilities() {
  return `Provenex Check evidence surfaces

The CLI only collects what you consent to. On a TTY it first checks bounded
Claude/Codex metadata for exact-project matches and asks before including full
sessions. Other exports, traces, audit logs, and advisories stay behind an
optional file offer. Then one hosted call (given a key) scores consented
evidence. Private scoring rules stay on the server; the report says what
compositions were visible and what to upload next.

Surface                    Unlocks
source and config          Credential shapes, payment/webhook mistakes,
                           agent auto-approve, CI pull_request_target
AI sessions                Prompt/tool-call review from Claude/Codex JSONL
                           or a ChatGPT/Claude conversations.json export
runtime traces (--telemetry)
                           Reachable agent compositions: untrusted input,
                           privileged data, and outbound sends. Accepts
                           OTLP, Langfuse JSON, LangSmith REST runs,
                           and LangChain OpenLLMetry/OpenInference. Use
                           --telemetry-format bedrock for CloudWatch
                           FilterLogEvents model-invocation logs. Gaps say
                           which parent links or tool fields are missing
GitHub audit (--telemetry-format github)
                           Org/enterprise audit-log JSON (Copilot seats,
                           git.clone, repo.zip). Not Actions job logs
deploy logs (audit)        Runtime errors and credential-shaped log lines
                           (--cloudwatch-log or --fly-log)
cost export (audit)        Spend-to-review from Cost Explorer JSON grouped
                           by SERVICE. Finalized months still score when the
                           current month is Estimated; only estimated-only
                           exports stay not-evaluated. Not guaranteed savings.
dependency audit           Advisory records you already generated locally

Cursor databases, browser profiles, and authentication stores are never
accepted. plan lists what is on disk without uploading it.

Suggested first run:
  provenex-check plan .
  provenex-check scan . --dry-run
`;
}

export async function renderPlan(targetPath) {
  const root = await resolveScanRoot(targetPath);
  const target = targetLabelForRoot(root);
  const { languages, hits, truncated } = await inventory(root);
  const aiHistory = await inspectAiHistory(root);
  const sessionMatches = aiHistory.matches.length;
  const languageLine = [...languages.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([name, count]) => `${name} (${count})`)
    .join(', ') || '(none recognized)';

  const suggested = ['provenex-check', 'scan', '.'];
  if (sessionMatches > 0) suggested.push('--discover-ai-history');
  if (hits.otelFiles[0]) suggested.push('--telemetry', hits.otelFiles[0]);
  suggested.push('--dry-run');

  const lines = [
    `Provenex Check plan — ${target}`,
    `Languages: ${languageLine}`,
    `GitHub workflows: ${hits.workflows}`,
    `IaC / deploy manifests: ${hits.iac}`,
    `MCP / agent config files: ${hits.mcp}`,
    `Agent instruction files: ${hits.agentDocs}`,
    `Environment / secret-shaped files: ${hits.envFiles} (contents not read by plan)`,
    `Host hints: ${[
      hits.fly ? 'Fly' : null,
      hits.vercel ? 'Vercel' : null,
      hits.supabase ? 'Supabase' : null,
    ].filter(Boolean).join(', ') || '(none)'}`,
    aiHistory.status === 'unavailable'
      ? 'Claude/Codex session discovery: unavailable (the bounded metadata check could not finish safely).'
      : `Claude/Codex sessions with an exact-cwd match: ${sessionMatches} (filenames are not listed)`,
    hits.otelFiles.length
      ? `Possible trace exports (not uploaded): ${hits.otelFiles.join(', ')}`
      : 'No obvious OTLP/trace export filenames were observed.',
    truncated ? 'Inventory stopped at a traversal bound; treat this list as incomplete.' : null,
    '',
    'Suggested next command (uploads nothing until you drop --dry-run):',
    `  ${suggested.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')}`,
    '',
    'Run provenex-check capabilities to add telemetry, audit logs, or dependency evidence.',
  ].filter((line) => line !== null);
  return `${lines.join('\n')}\n`;
}
