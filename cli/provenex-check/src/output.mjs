import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveOutput(outputPath, root, force) {
  const requested = path.resolve(outputPath);
  const parent = path.dirname(requested);
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`output parent does not exist: ${parent}`);
    throw error;
  }
  if (!parentInfo.isDirectory()) throw new Error(`output parent is not a directory: ${parent}`);
  const canonicalParent = await realpath(parent);
  const canonical = path.join(canonicalParent, path.basename(requested));
  if (isWithin(root, canonical)) {
    throw new Error('report outputs must be outside the scanned directory');
  }

  try {
    const existing = await lstat(canonical);
    if (existing.isSymbolicLink()) throw new Error(`refusing symbolic-link output: ${requested}`);
    if (!existing.isFile()) throw new Error(`existing output is not a regular file: ${requested}`);
    if (!force) throw new Error(`output already exists (use --force for a regular file): ${requested}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return canonical;
}

export async function prepareOutputs(outputs, root, force) {
  const prepared = {};
  if (outputs.json) prepared.json = await resolveOutput(outputs.json, root, force);
  if (outputs.html) prepared.html = await resolveOutput(outputs.html, root, force);
  if (prepared.json && prepared.html && prepared.json === prepared.html) {
    throw new Error('--json and --html must use different output paths');
  }
  return prepared;
}

export async function atomicWrite(destination, content, force) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (force) {
      const existing = await lstat(destination).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`refusing unsafe output replacement: ${destination}`);
      }
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
    }
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`output already exists: ${destination}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function writeReports(prepared, response, renderedHtml, force) {
  const written = [];
  if (prepared.json) {
    await atomicWrite(prepared.json, `${JSON.stringify(response, null, 2)}\n`, force);
    written.push(prepared.json);
  }
  if (prepared.html) {
    await atomicWrite(prepared.html, renderedHtml, force);
    written.push(prepared.html);
  }
  return written;
}
