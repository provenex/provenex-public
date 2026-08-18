import { constants as fsConstants } from 'node:fs';
import { lstat, opendir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { createExcludeMatcher } from './excludes.mjs';
import { getGitStates, gitStateFor } from './git.mjs';
import { DISCOVERY_LIMITS, SERVER_LIMITS } from './limits.mjs';

export const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);
const EXCLUDED_DIRECTORIES = new Set(DEFAULT_EXCLUDED_DIRECTORIES);

const SOURCE_EXTENSIONS = new Set([
  '.astro', '.bash', '.c', '.cc', '.cfg', '.cjs', '.clj', '.cmake', '.conf',
  '.cpp', '.cs', '.css', '.csv', '.cxx', '.dart', '.env', '.ex', '.exs', '.fish', '.go',
  '.graphql', '.h', '.hh', '.hpp', '.hxx', '.ini', '.java', '.js', '.json',
  '.gradle', '.html', '.json5', '.jsonc', '.jsx', '.kt', '.kts', '.lua', '.m', '.md', '.mdx', '.mjs',
  '.mk', '.mm', '.php', '.pl', '.plist', '.properties', '.proto', '.ps1', '.py', '.rb',
  '.rs', '.scala', '.scss', '.sh', '.sol', '.sql', '.svelte', '.swift', '.tf',
  '.tfvars', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.xcconfig', '.yaml', '.yml', '.zig',
  '.bazel', '.bzl', '.pbxproj', '.zsh',
]);

const SOURCE_NAMES = new Set([
  'Android.mk', 'Application.mk', 'BUILD', 'BUILD.bazel', 'Brewfile',
  'CMakeLists.txt', 'Containerfile', 'Dockerfile', 'Gemfile',
  'Gemfile.lock', 'Justfile', 'Makefile', 'Package.resolved', 'Podfile',
  'Podfile.lock', 'Procfile', 'Rakefile', 'Vagrantfile', 'build.gradle',
  'build.gradle.kts', 'bun.lock', 'bun.lockb', 'cargo.lock', 'cargo.toml',
  '.dockercfg', '.dockerconfigjson', '.netrc', '.npmrc', '.pypirc', '.terraformrc',
  '.yarnrc', 'composer.json', 'composer.lock', 'credentials', 'deno.json',
  'deno.jsonc', 'go.mod', 'go.sum',
  'gradle.properties', 'package-lock.json', 'package.json', 'pnpm-lock.yaml',
  'meson.build', 'project.pbxproj', 'pyproject.toml', 'requirements.txt',
  'settings.gradle', 'settings.gradle.kts', 'uv.lock', 'WORKSPACE',
  'WORKSPACE.bazel', 'yarn.lock',
]);

const decoder = new TextDecoder('utf-8', { fatal: true });
const metadataDecoder = new TextDecoder('utf-8', { fatal: true });
const MAX_SOURCE_ENTRIES = 200_000;
const MAX_SOURCE_DIRECTORIES = 50_000;
const METADATA_READ_CHUNK_BYTES = 4 * 1024;

export function localHomePath() {
  return process.env.HOME ? path.resolve(process.env.HOME) : homedir();
}

function isEqualOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRelative(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('collector encountered a path outside the scan root');
  }
  const normalized = relative.split(path.sep).join('/');
  if (
    Buffer.byteLength(normalized) > SERVER_LIMITS.maxRelativePathBytes
    || normalized.startsWith('/')
    || normalized.endsWith('/')
    || normalized.includes('\\')
    || normalized.includes(':')
    || normalized.includes('//')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
    || normalized.split('/').some((part) => ['.git', '.hg', '.svn'].includes(part))
  ) {
    throw new Error(`source path cannot be represented by the hosted contract: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

function localRelative(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('collector encountered a path outside the scan root');
  }
  return relative.split(path.sep).join('/');
}

function isSourceFile(name) {
  const lower = name.toLowerCase();
  if (lower === 'conversations.json') return false;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower === '.envrc' || lower.startsWith('.envrc.')) return true;
  if (lower === '.dev.vars' || lower.startsWith('.dev.vars.')) return true;
  if (SOURCE_NAMES.has(name) || SOURCE_NAMES.has(lower)) return true;
  if (/^requirements([.-].+)?\.txt$/i.test(name)) return true;
  return SOURCE_EXTENSIONS.has(path.extname(lower));
}

async function readAtMost(handle, maxBytes) {
  const chunks = [];
  let bytes = 0;
  while (bytes <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (maxBytes + 1) - bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    bytes += bytesRead;
  }
  return { buffer: Buffer.concat(chunks, bytes), bytes };
}

async function readRegularUtf8(filePath, maxBytes, label) {
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if (before.size > maxBytes) {
    throw new Error(`${label} is ${before.size} bytes; limit is ${maxBytes}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link`);
    throw error;
  }
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new Error(`${label} must be a regular file`);
    if (current.size > maxBytes) {
      throw new Error(`${label} is ${current.size} bytes; limit is ${maxBytes}`);
    }
    const read = await readAtMost(handle, maxBytes);
    const after = await handle.stat();
    if (read.bytes > maxBytes || after.size > maxBytes) {
      throw new Error(`${label} is at least ${Math.max(read.bytes, after.size)} bytes; limit is ${maxBytes}`);
    }
    try {
      return { content: decoder.decode(read.buffer), bytes: read.bytes };
    } catch {
      throw new Error(`${label} is not valid UTF-8 text`);
    }
  } finally {
    await handle.close();
  }
}

async function enumerate(
  root,
  excludePatterns,
  protectedAbsolutePaths,
  protectedAbsoluteDirectories,
) {
  const files = [];
  const isUserExcluded = createExcludeMatcher(excludePatterns);
  let userExcludedEntries = 0;
  let entriesVisited = 0;
  let directoriesVisited = 0;
  async function visit(directory) {
    directoriesVisited += 1;
    if (directoriesVisited > MAX_SOURCE_DIRECTORIES) {
      throw new Error(`source traversal exceeds ${MAX_SOURCE_DIRECTORIES} directories`);
    }
    const entries = [];
    for await (const entry of await opendir(directory)) {
      entriesVisited += 1;
      if (entriesVisited > MAX_SOURCE_ENTRIES) {
        throw new Error(`source traversal exceeds ${MAX_SOURCE_ENTRIES} directory entries`);
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (protectedAbsolutePaths.has(path.resolve(absolute))) continue;
      if (entry.isDirectory() && protectedAbsoluteDirectories.has(path.resolve(absolute))) continue;
      const relative = localRelative(root, absolute);
      if (isUserExcluded(relative)) {
        userExcludedEntries += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return { files, userExcludedEntries };
}

function metadataRecordMatchesRoot(record, root) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.cwd === 'string') return record.cwd === root;
  return record.type === 'session_meta'
    && record.payload
    && typeof record.payload === 'object'
    && !Array.isArray(record.payload)
    && typeof record.payload.cwd === 'string'
    && record.payload.cwd === root;
}

async function readFirstSessionMetadataRecord(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { record: null, bytes: 0 };

    const chunks = [];
    let bytes = 0;
    let complete = false;
    while (bytes < DISCOVERY_LIMITS.maxFirstRecordBytes) {
      const remaining = DISCOVERY_LIMITS.maxFirstRecordBytes - bytes;
      const buffer = Buffer.allocUnsafe(Math.min(METADATA_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) {
        complete = bytes > 0;
        break;
      }
      const read = buffer.subarray(0, bytesRead);
      const newline = read.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(read.subarray(0, newline));
        bytes += newline + 1;
        complete = true;
        break;
      }
      chunks.push(read);
      bytes += bytesRead;
    }

    if (!complete && bytes === DISCOVERY_LIMITS.maxFirstRecordBytes && info.size <= bytes) {
      complete = true;
    }
    if (!complete) return { record: null, bytes };

    let record;
    try {
      const text = metadataDecoder.decode(Buffer.concat(chunks));
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    return { record, bytes };
  } finally {
    await handle.close();
  }
}

async function discoverUnder(directory, root, state) {
  state.directories += 1;
  if (state.directories > DISCOVERY_LIMITS.maxDirectories) {
    throw new Error(`AI history discovery exceeds ${DISCOVERY_LIMITS.maxDirectories} directories`);
  }
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;

  const entries = [];
  for await (const entry of await opendir(directory)) {
    state.entries += 1;
    if (state.entries > DISCOVERY_LIMITS.maxDirectoryEntries) {
      throw new Error(`AI history discovery exceeds ${DISCOVERY_LIMITS.maxDirectoryEntries} directory entries`);
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await discoverUnder(absolute, root, state);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') continue;
    state.examined += 1;
    if (state.examined > DISCOVERY_LIMITS.maxCandidateFiles) {
      throw new Error(`AI history discovery exceeds ${DISCOVERY_LIMITS.maxCandidateFiles} candidate session files`);
    }
    let metadata;
    try {
      metadata = await readFirstSessionMetadataRecord(absolute);
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'ENOENT' || error?.code === 'ELOOP') continue;
      throw error;
    }
    state.metadataBytes += metadata.bytes;
    if (state.metadataBytes > DISCOVERY_LIMITS.maxMetadataBytes) {
      throw new Error(`AI history discovery exceeds ${DISCOVERY_LIMITS.maxMetadataBytes} metadata bytes`);
    }
    if (metadataRecordMatchesRoot(metadata.record, root)) {
      state.matches.push({
        kind: 'session',
        path: absolute,
        discovered: true,
      });
    }
  }
}

export async function discoverAiHistory(root) {
  const state = { directories: 0, entries: 0, examined: 0, metadataBytes: 0, matches: [] };
  const userHome = localHomePath();
  await discoverUnder(path.join(userHome, '.claude', 'projects'), root, state);
  await discoverUnder(path.join(userHome, '.codex', 'sessions'), root, state);
  return state.matches;
}

function categoryForSource(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'environment_secrets';
  if (name === '.envrc' || name.startsWith('.envrc.')) return 'environment_secrets';
  if (name === '.dev.vars' || name.startsWith('.dev.vars.')) return 'environment_secrets';
  if (name === 'credentials') return 'environment_secrets';
  if (['.dockercfg', '.dockerconfigjson', '.netrc', '.npmrc', '.pypirc', '.terraformrc', '.yarnrc'].includes(name)) {
    return 'environment_secrets';
  }
  const extension = path.posix.extname(name);
  if (['.json', '.json5', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.plist', '.properties', '.tfvars'].includes(extension)) {
    return 'configuration';
  }
  return 'source_code';
}

const ARTIFACT_CATEGORIES = {
  session: 'ai_session_history',
  conversation_export: 'ai_session_history',
  fly_log: 'platform_logs',
  cloudwatch_log: 'cloud_logs',
  aws_cost: 'cloud_cost_and_usage',
  dependency_audit: 'dependency_audit',
};

export async function resolveScanRoot(targetPath) {
  const requested = path.resolve(targetPath);
  const info = await lstat(requested).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`scan path does not exist: ${requested}`);
    throw error;
  });
  if (info.isSymbolicLink()) throw new Error('scan path must not be a symbolic link');
  if (!info.isDirectory()) throw new Error('scan path must be a directory');
  const root = await realpath(requested);
  if (path.parse(root).root === root) throw new Error('refusing to scan a filesystem root');
  const configuredHome = path.resolve(localHomePath());
  const canonicalHome = await realpath(configuredHome).catch((error) => {
    if (error?.code === 'ENOENT') return configuredHome;
    throw new Error('unable to canonicalize the home-directory scan boundary');
  });
  if (isEqualOrWithin(root, canonicalHome)) {
    throw new Error('refusing to scan the home directory or one of its ancestors; select a project subdirectory');
  }
  return root;
}

export function targetLabelForRoot(root) {
  const original = path.basename(root);
  let cleaned = original.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '�').trim();
  if (cleaned.length === 0) cleaned = 'project';
  if (Buffer.byteLength(cleaned) <= SERVER_LIMITS.maxTargetBytes) return cleaned;

  let bounded = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(`${bounded}${character}...`) > SERVER_LIMITS.maxTargetBytes) break;
    bounded += character;
  }
  return `${bounded}...`;
}

export async function collectDataset({
  root,
  artifactInputs,
  excludes = [],
  protectedFiles = [],
  protectedDirectories = [],
  limits,
}) {
  if (artifactInputs.length > SERVER_LIMITS.maxArtifacts) {
    throw new Error(
      `artifact selection contains ${artifactInputs.length} files; limit is ${SERVER_LIMITS.maxArtifacts}`,
    );
  }
  for (const [kind, limit] of [
    ['aws_cost', SERVER_LIMITS.maxAwsCostArtifacts],
    ['dependency_audit', SERVER_LIMITS.maxDependencyAuditArtifacts],
  ]) {
    const count = artifactInputs.filter((input) => input.kind === kind).length;
    if (count > limit) {
      throw new Error(`${kind} artifact selection contains ${count} files; limit is ${limit}`);
    }
  }
  const protectedAbsolutePaths = new Set(await Promise.all(protectedFiles.map(async (file) => {
    const resolved = path.resolve(file);
    try {
      return await realpath(resolved);
    } catch (error) {
      if (error?.code === 'ENOENT') return resolved;
      throw new Error('unable to canonicalize a protected local credential store');
    }
  })));
  const protectedAbsoluteDirectories = new Set(await Promise.all(protectedDirectories.map(async (directory) => {
    const resolved = path.resolve(directory);
    try {
      return await realpath(resolved);
    } catch (error) {
      if (error?.code === 'ENOENT') return resolved;
      throw new Error('unable to canonicalize a protected AI-history directory');
    }
  })));
  if ([...protectedAbsoluteDirectories].some((directory) => isEqualOrWithin(directory, root))) {
    throw new Error(
      'refusing to scan a protected AI-history directory; use explicit AI-history consent from a project scan',
    );
  }
  const selection = await enumerate(
    root,
    excludes,
    protectedAbsolutePaths,
    protectedAbsoluteDirectories,
  );
  const candidateFiles = selection.files;
  if (candidateFiles.length > limits.maxFiles) {
    throw new Error(`source selection contains ${candidateFiles.length} files; limit is ${limits.maxFiles}`);
  }
  const gitStates = await getGitStates(root);
  const sourceFiles = [];
  const artifacts = [];
  const categories = new Set();
  let totalBytes = 0;
  let discoveredSessionCount = 0;
  let discoveredSessionBytes = 0;
  const artifactSequence = new Map();
  const highSensitivitySourcePaths = [];
  const explicitArtifactInputs = [];

  for (const absolute of candidateFiles) {
    const relativePath = normalizeRelative(root, absolute);
    const read = await readRegularUtf8(absolute, limits.maxFileBytes, `source file ${relativePath}`);
    totalBytes += read.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`selected data exceeds aggregate limit of ${limits.maxTotalBytes} bytes`);
    }
    const category = categoryForSource(relativePath);
    categories.add(category);
    if (category === 'environment_secrets') {
      highSensitivitySourcePaths.push(relativePath);
    }
    sourceFiles.push({
      relative_path: relativePath,
      content: read.content,
      git_state: gitStateFor(relativePath, gitStates),
    });
  }

  for (const input of artifactInputs) {
    const absolute = path.resolve(input.path);
    const basename = path.basename(absolute);
    const canonicalAbsolute = await realpath(absolute).catch((error) => {
      if (error?.code === 'ENOENT') return absolute;
      throw error;
    });
    if (protectedAbsolutePaths.has(canonicalAbsolute)) {
      throw new Error('a protected local credential store cannot be selected as an artifact');
    }
    if (basename.toLowerCase() === 'conversations.json' && input.kind !== 'session') {
      throw new Error('web conversation exports require explicit --session-input consent');
    }
    if (
      [...protectedAbsoluteDirectories].some((directory) => isEqualOrWithin(directory, canonicalAbsolute))
      && input.kind !== 'session'
    ) {
      throw new Error('artifacts under protected AI-history roots require explicit --session-input consent');
    }
    let kind = input.kind;
    if (kind === 'session') {
      if (!input.discovered && basename === 'conversations.json') {
        kind = 'conversation_export';
      } else if (path.extname(basename).toLowerCase() !== '.jsonl') {
        throw new Error(
          '--session-input must be a JSONL session or an exact conversations.json supported web export',
        );
      }
    }
    const read = await readRegularUtf8(absolute, limits.maxArtifactBytes, `${input.kind} artifact`);
    totalBytes += read.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`selected data exceeds aggregate limit of ${limits.maxTotalBytes} bytes`);
    }
    categories.add(ARTIFACT_CATEGORIES[kind]);
    const sequence = (artifactSequence.get(kind) || 0) + 1;
    artifactSequence.set(kind, sequence);
    const labelPrefix = kind.replaceAll('_', '-');
    const extension = kind === 'session' || kind === 'fly_log' ? 'jsonl' : 'json';
    artifacts.push({
      kind,
      name: `${labelPrefix}-${String(sequence).padStart(3, '0')}.${extension}`,
      content: read.content,
    });
    if (input.discovered) {
      discoveredSessionCount += 1;
      discoveredSessionBytes += read.bytes;
    } else {
      explicitArtifactInputs.push({ kind, localPath: absolute, bytes: read.bytes });
    }
  }

  const sourceBytes = sourceFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const artifactBytes = artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.content), 0);
  if (categories.size > SERVER_LIMITS.maxConsentCategories) {
    throw new Error(
      `selected data requires ${categories.size} consent categories; limit is ${SERVER_LIMITS.maxConsentCategories}`,
    );
  }
  return {
    sourceFiles,
    artifacts,
    categories: [...categories].sort(),
    sourceBytes,
    artifactBytes,
    totalBytes,
    discoveredSessionCount,
    discoveredSessionBytes,
    userExcludePatternCount: excludes.length,
    userExcludedEntries: selection.userExcludedEntries,
    userExcludePatterns: [...excludes],
    highSensitivitySourcePaths,
    explicitArtifactInputs,
  };
}

export const SENSITIVE_CATEGORIES = new Set([
  'configuration',
  'environment_secrets',
  'ai_session_history',
  'platform_logs',
  'cloud_logs',
  'cloud_cost_and_usage',
]);
