import { spawnSync } from 'node:child_process';

const WORLD_TRUSTEE = /(?:^|[\\/\s])(Everyone|Users|Authenticated Users|Guests):(?<rights>\([^)]+\))/gi;

export function windowsAclGrantsWorldAccess(text) {
  WORLD_TRUSTEE.lastIndex = 0;
  for (const match of String(text).matchAll(WORLD_TRUSTEE)) {
    const rights = match.groups.rights.toUpperCase();
    if (rights === '(N)') continue;
    return true;
  }
  return false;
}

function inspectWindowsAcl(filePath) {
  const result = spawnSync('icacls', [filePath], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, output: `${result.stdout || ''}\n${result.stderr || ''}` };
  }
  return { ok: true, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

export function assertOwnerRestrictedFile(info, filePath, fail) {
  if (process.platform === 'win32') {
    const inspected = inspectWindowsAcl(filePath);
    if (!inspected.ok) fail('must be owner-only (ACL could not be inspected)');
    if (windowsAclGrantsWorldAccess(inspected.output)) {
      fail('must be owner-only (no Users, Everyone, or Authenticated Users ACL)');
    }
    return;
  }
  if ((info.mode & 0o077) !== 0) fail('must be owner-only (chmod 600)');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail('must be owned by the current user');
  }
}
