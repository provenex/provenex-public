import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const EXPECTED_FILES = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'bin/provenex-check.js',
  'openapi/provenex-check.v1.yaml',
  'package.json',
  'schemas/provenex-check-request.v1.schema.json',
  'schemas/provenex-check-response.v1.schema.json',
  'src/args.mjs',
  'src/client.mjs',
  'src/collector.mjs',
  'src/errors.mjs',
  'src/excludes.mjs',
  'src/fix-prompt.mjs',
  'src/git.mjs',
  'src/limits.mjs',
  'src/main.mjs',
  'src/output.mjs',
  'src/plan.mjs',
  'src/policy.mjs',
  'src/prompt.mjs',
  'src/render.mjs',
  'src/report.mjs',
  'src/verification.mjs',
].sort();

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  shell: false,
});

if (packed.error) throw packed.error;
if (packed.status !== 0) {
  throw new Error(`npm pack --dry-run failed:\n${packed.stderr.trim()}`);
}

let manifest;
try {
  manifest = JSON.parse(packed.stdout);
} catch {
  throw new Error('npm pack --dry-run did not return its JSON manifest');
}

// npm 11 returns an ARRAY of manifests from `npm pack --json`; npm 12 returns
// an OBJECT keyed by package name. The publish workflow pins npm 12.0.2 because
// trusted publishing requires >= 11.5.1, so this script ran green on every
// developer machine and failed only inside the release, at the one step whose
// whole job is to guard the published boundary. Normalize both shapes.
const manifests = Array.isArray(manifest) ? manifest : Object.values(manifest);
assert.equal(manifests.length, 1, 'expected one npm package manifest');
const packaged = manifests[0];
assert.ok(
  Array.isArray(packaged?.files),
  'npm pack manifest did not carry a files array; the npm JSON contract changed again',
);
const actualFiles = packaged.files.map(({ path }) => path).sort();
assert.deepEqual(
  actualFiles,
  EXPECTED_FILES,
  'packed source contents changed; review the public/private boundary and update this assertion intentionally',
);

const executable = packaged.files.find(({ path }) => path === 'bin/provenex-check.js');
assert.ok((executable.mode & 0o111) !== 0, 'packaged CLI entry point must remain executable');
process.stdout.write(`Verified ${actualFiles.length} explicitly approved package files.\n`);
