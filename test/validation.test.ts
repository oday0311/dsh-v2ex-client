import assert from 'node:assert/strict';
import test from 'node:test';
import { V2exError } from '../src/errors.js';
import { assertLimit, assertNodeName, assertPage, assertTopicId } from '../src/validation.js';

test('request path inputs reject traversal and malformed identifiers', () => {
  for (const value of ['../api/v2/token', 'foo/bar', 'foo?bar', 'foo%2fbar', '']) {
    assert.throws(() => assertNodeName(value), (error: unknown) =>
      error instanceof V2exError && error.code === 'invalid_request');
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1,
    '', '0', '00123', '+123', '-123', '1.5', '123/../../token', '9007199254740992']) {
    assert.throws(() => assertTopicId(value), (error: unknown) =>
      error instanceof V2exError && error.code === 'invalid_request');
  }
});

test('topic IDs accept canonical decimal strings up to the safe-integer limit', () => {
  assert.equal(assertTopicId('123'), 123);
  assert.equal(assertTopicId('9007199254740991'), Number.MAX_SAFE_INTEGER);
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
