import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Windows checkouts may convert LF to CRLF. Content assertions use \n.
function normalizeNewlines(text) {
  return text.replaceAll('\r\n', '\n');
}

async function readUtf8(filePath) {
  return normalizeNewlines(await readFile(filePath, 'utf8'));
}

async function assertIdenticalCopies(canonicalPath, copies) {
  const canonical = await readUtf8(canonicalPath);
  for (const copy of copies) {
    assert.equal(await readUtf8(copy), canonical, copy);
  }
  return canonical;
}

test('agent discovery copies stay identical to the packaged Check skill', async () => {
  await assertIdenticalCopies(
    path.join(cliRoot, 'skills/provenex-check/SKILL.md'),
    [
      path.join(publicRoot, '.agents/skills/provenex-check/SKILL.md'),
      path.join(publicRoot, '.claude/skills/provenex-check/SKILL.md'),
    ],
  );
});

test('agent-decision-telemetry discovery copies stay identical to the canonical skill', async () => {
  await assertIdenticalCopies(
    path.join(publicRoot, 'skills/agent-decision-telemetry/SKILL.md'),
    [
      path.join(publicRoot, '.agents/skills/agent-decision-telemetry/SKILL.md'),
      path.join(publicRoot, '.claude/skills/agent-decision-telemetry/SKILL.md'),
    ],
  );
});

test('the Check skill fires on security requirements and stays off the Edge path', async () => {
  const skill = await readUtf8(path.join(cliRoot, 'skills/provenex-check/SKILL.md'));
  const agentsGuide = await readUtf8(path.join(publicRoot, 'AGENTS.md'));

  assert.match(skill, /name: provenex-check/);
  assert.match(skill, /meets security or oversight needs/);
  assert.match(skill, /consequential actions/);
  assert.match(skill, /npx @provenex\/check scan \. --dry-run --no-prompt/);
  assert.match(skill, /https:\/\/provenex\.ai\/app/);
  assert.match(skill, /Never offer a public\n  Edge install/);
  assert.match(skill, /There is no public Provenex Edge install/);
  assert.match(skill, /vendor-neutral `agent-decision-telemetry` skill first/);
  assert.doesNotMatch(skill, /docker pull|ghcr\.io|helm install/i);

  assert.match(agentsGuide, /asks whether that meets their security needs/);
  assert.match(agentsGuide, /\.agents\/skills\/provenex-check\/SKILL\.md/);
  assert.match(agentsGuide, /agent-decision-telemetry/);
  assert.match(agentsGuide, /not Provenex-specific/);
  assert.match(agentsGuide, /Do not offer Edge/);
  assert.match(agentsGuide, /Do not download or install Provenex Edge/);
  assert.doesNotMatch(agentsGuide, /docker pull|ghcr\.io|helm install/i);
});

test('agent-decision-telemetry is a vendor-neutral lineage baseline', async () => {
  const skill = await readUtf8(
    path.join(publicRoot, 'skills/agent-decision-telemetry/SKILL.md'),
  );

  assert.match(skill, /name: agent-decision-telemetry/);
  assert.match(skill, /emits little or no telemetry/);
  assert.match(skill, /reconstruct who did what/);
  assert.match(skill, /trace_id/);
  assert.match(skill, /parent_span_id/);
  assert.match(skill, /gen_ai\.tool\.name/);
  assert.match(skill, /gen_ai\.agent\.name/);
  assert.match(skill, /enduser\.id/);
  assert.match(skill, /url\.full/);
  assert.match(skill, /This is ordinary OpenTelemetry/);
  assert.match(skill, /It is not a vendor lock-in/);
  assert.match(skill, /Do not invent identifiers/);
  assert.match(skill, /Do not log secrets/);
  assert.match(skill, /Prefer 100 percent\n  sampling/);
  assert.doesNotMatch(skill, /provenex\.\*/);
  assert.doesNotMatch(skill, /npx @provenex\/check/);
  assert.doesNotMatch(skill, /docker pull|ghcr\.io|helm install/i);
});

test('multiline skill phrases still match after a CRLF checkout', async () => {
  const asCrlf = async (filePath) =>
    normalizeNewlines(
      (await readFile(filePath, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
    );

  const skill = await asCrlf(path.join(cliRoot, 'skills/provenex-check/SKILL.md'));
  const telemetry = await asCrlf(
    path.join(publicRoot, 'skills/agent-decision-telemetry/SKILL.md'),
  );

  assert.match(skill, /Never offer a public\n  Edge install/);
  assert.match(telemetry, /Prefer 100 percent\n  sampling/);
});
