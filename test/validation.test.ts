import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exError } from '../src/errors.js';
import { assertLimit, assertNodeName, assertPage, assertTopicId } from '../src/validation.js';

test('request path inputs reject traversal and malformed identifiers', () => {
  for (const value of ['../api/v2/token', 'foo/bar', 'foo?bar', 'foo%2fbar', '']) {
    assert.throws(() => assertNodeName(value), (error: unknown) =>
      error instanceof V2exError && error.code === 'invalid_request');
  }
  for (const value of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertTopicId(value), (error: unknown) =>
      error instanceof V2exError && error.code === 'invalid_request');
  }
});

test('pagination inputs enforce positive bounded integers', () => {
  for (const input of [0, -1, 1.5, Infinity, '2']) {
    assert.throws(() => assertPage(input), { code: 'invalid_request' });
    assert.throws(() => assertLimit(input), { code: 'invalid_request' });
  }
  assert.equal(assertTopicId(42), 42);
  assert.equal(assertNodeName('python-3'), 'python-3');
  assert.equal(assertPage(2), 2);
  assert.equal(assertLimit(20), 20);
});
