import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsAclGrantsWorldAccess } from '../src/fs-policy.mjs';

test('windowsAclGrantsWorldAccess treats Users/Everyone/Guests as world access', () => {
  assert.equal(
    windowsAclGrantsWorldAccess('report.json NT AUTHORITY\\SYSTEM:(F)\n                 BUILTIN\\Administrators:(F)\n                 RUNNER\\runneradmin:(R)\n'),
    false,
  );
  assert.equal(
    windowsAclGrantsWorldAccess('report.json BUILTIN\\Users:(R)\n                 NT AUTHORITY\\SYSTEM:(F)\n'),
    true,
  );
  assert.equal(
    windowsAclGrantsWorldAccess('key.json Everyone:(F)\n'),
    true,
  );
  assert.equal(
    windowsAclGrantsWorldAccess('key.json NT AUTHORITY\\Authenticated Users:(RX)\n'),
    true,
  );
  assert.equal(
    windowsAclGrantsWorldAccess('key.json BUILTIN\\Users:(N)\n                 RUNNER\\runneradmin:(R)\n'),
    false,
  );
});
