// tests/housekeeping.test.mjs — P129 pure logic (node --test). Add to package.json "test".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return 'electron-stub';
  return origResolve.call(this, req, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: { app: { requestSingleInstanceLock: () => true, on() {}, getPath: () => '.' } } };
const { isStaleScratch } = require('../dist/main/main/housekeeping.js');

test('only our scratch names, only when old', () => {
  const now = 10 * 24 * 3600 * 1000;
  const old = now - 2 * 24 * 3600 * 1000;
  assert.equal(isStaleScratch('sw_vbs_123_ab.vbs', old, now), true);
  assert.equal(isStaleScratch('sw_result_123.json', old, now), true);
  assert.equal(isStaleScratch('sw_script_123.py', old, now), true);
  assert.equal(isStaleScratch('sw_vbs_123_ab.vbs', now - 1000, now), false);   // fresh: in use
  assert.equal(isStaleScratch('user_file.vbs', old, now), false);              // not ours
  assert.equal(isStaleScratch('sw_vbs_123.txt', old, now), false);             // wrong ext
});
