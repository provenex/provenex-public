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
  'src/checkpoint.mjs',
  'src/client.mjs',
  'src/collector.mjs',
  'src/errors.mjs',
  'src/explain.mjs',
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
  'types/checkpoint.d.ts',
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

assert.equal(manifest.length, 1, 'expected one npm package manifest');
const actualFiles = manifest[0].files.map(({ path }) => path).sort();
assert.deepEqual(
  actualFiles,
  EXPECTED_FILES,
  'packed source contents changed; review the public/private boundary and update this assertion intentionally',
);

const executable = manifest[0].files.find(({ path }) => path === 'bin/provenex-check.js');
assert.ok((executable.mode & 0o111) !== 0, 'packaged CLI entry point must remain executable');
process.stdout.write(`Verified ${actualFiles.length} explicitly approved package files.\n`);
