import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretRedactor } from '../lib/secret-redactor.js';

test('streaming secret redactor masks credentials split across chunks', () => {
  const output = [];
  const redactor = createSecretRedactor('private-pass', text => output.push(text));
  redactor.write('Echo: priv');
  redactor.write('ate-');
  redactor.write('pass');
  redactor.write(' and welcome.\n');
  redactor.flush();
  assert.equal(output.join(''), 'Echo: [password echo hidden] and welcome.\n');
  assert.doesNotMatch(output.join(''), /private-pass/);
});

test('streaming secret redactor hides an incomplete echoed credential at close', () => {
  const output = [];
  const redactor = createSecretRedactor('private-pass', text => output.push(text));
  redactor.write('Prompt: private-');
  redactor.flush();
  assert.equal(output.join(''), 'Prompt: [password echo hidden]');
  assert.doesNotMatch(output.join(''), /private-/);
});
