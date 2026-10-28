import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerOn } from './inject.mjs';

test('memory_v2 switch: off, on for everyone, on for listed owners only', () => {
  assert.equal(ownerOn(undefined, 'claude'), false);
  assert.equal(ownerOn({ enabled: false, owners: ['claude'] }, 'claude'), false);
  assert.equal(ownerOn({ enabled: true }, 'codex'), true);
  assert.equal(ownerOn({ enabled: true, owners: ['claude'] }, 'claude'), true);
  assert.equal(ownerOn({ enabled: true, owners: ['claude'] }, 'codex'), false);
});
