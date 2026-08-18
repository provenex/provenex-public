import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeModulesBin(directory) {
  return path.basename(directory).toLowerCase() === '.bin'
    && path.basename(path.dirname(directory)).toLowerCase() === 'node_modules';
}

async function safePathDirectories(root) {
  const directories = [];
  const seen = new Set();
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const lexical = path.resolve(entry);
    if (isWithin(root, lexical) || isNodeModulesBin(lexical)) continue;
    let resolved;
    try {
      resolved = await realpath(lexical);
      if (!(await stat(resolved)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isWithin(root, resolved) || isNodeModulesBin(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    directories.push(resolved);
  }
  return directories;
}

async function resolveGitExecutable(root, directories) {
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of directories) {
    const lexical = path.resolve(directory, executableName);
    if (isWithin(root, lexical)) continue;
    let resolved;
    try {
      resolved = await realpath(lexical);
      if (isWithin(root, resolved) || !(await stat(resolved)).isFile()) continue;
      await access(resolved, fsConstants.X_OK);
    } catch {
      continue;
    }
    return resolved;
  }
  return null;
}

function gitEnvironment(directories) {
  const environment = { ...process.env };
  const excluded = new Set([
    'PROVENEX_API_KEY',
    'PROVENEX_CHECK_DEV_API_KEY',
    'GIT_EXEC_PATH',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ]);
  for (const key of Object.keys(environment)) {
    if (excluded.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete environment[key];
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.PATH = directories.join(path.delimiter);
  return environment;
}

function runGit(executable, root, environment, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, [
      '--no-pager',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-C', root,
      ...args,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: environment,
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
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return null;
  }
  const directories = await safePathDirectories(canonicalRoot);
  const executable = await resolveGitExecutable(canonicalRoot, directories);
  if (!executable) return null;
  const environment = gitEnvironment(directories);
  const inside = await runGit(
    executable,
    canonicalRoot,
    environment,
    ['rev-parse', '--is-inside-work-tree'],
  );
  if (!inside || inside.toString('utf8').trim() !== 'true') return null;
  const [tracked, untracked, ignored] = await Promise.all([
    runGit(executable, canonicalRoot, environment, ['ls-files', '-z', '--cached']),
    runGit(executable, canonicalRoot, environment, ['ls-files', '-z', '--others', '--exclude-standard']),
    runGit(
      executable,
      canonicalRoot,
      environment,
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
    ),
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
