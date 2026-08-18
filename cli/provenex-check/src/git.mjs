import { spawn } from 'node:child_process';

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function runGit(root, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || exceeded) resolve(null);
      else resolve(Buffer.concat(chunks));
    });
  });
}

function nulSet(buffer) {
  if (!buffer) return null;
  return new Set(
    buffer
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.replaceAll('\\', '/')),
  );
}

export async function getGitStates(root) {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.toString('utf8').trim() !== 'true') return null;
  const [tracked, untracked, ignored] = await Promise.all([
    runGit(root, ['ls-files', '-z', '--cached']),
    runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']),
    runGit(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']),
  ]);
  if (!tracked || !untracked || !ignored) return null;
  return { tracked: nulSet(tracked), untracked: nulSet(untracked), ignored: nulSet(ignored) };
}

export function gitStateFor(relativePath, states) {
  if (!states) return 'unknown';
  if (states.tracked.has(relativePath)) return 'tracked';
  if (states.untracked.has(relativePath)) return 'untracked';
  if (states.ignored.has(relativePath)) return 'ignored';
  return 'unknown';
}
