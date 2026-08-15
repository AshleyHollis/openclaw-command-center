import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMode, DeploymentMode, requiredValidationChecks } from '../src/persistence/mode.mjs';

test('mode evaluation defaults closed for missing or thrown validation checks', () => {
  const missing = evaluateMode([]);
  assert.equal(missing.mode, DeploymentMode.RecoveryOnly);
  assert.equal(missing.failures[0].code, 'VALIDATION_CHECK_MISSING');
  const results = requiredValidationChecks.map((name) => ({ name, ok: true }));
  results[0] = { name: 'sqlite-integrity', ok: false, code: 'VALIDATION_CHECK_FAILED', critical: true, guidance: 'Restore a verified archive.' };
  assert.equal(evaluateMode(results).mode, DeploymentMode.RecoveryOnly);
});

test('an optional capability failure degrades only that capability', () => {
  const results = requiredValidationChecks.map((name) => ({ name, ok: true }));
  results.push({ name: 'projections', ok: false, code: 'PROJECTION_UNAVAILABLE', capability: 'projections', critical: false, guidance: 'Rebuild projections.' });
  const evaluation = evaluateMode(results);
  assert.equal(evaluation.mode, DeploymentMode.Degraded);
  assert.deepEqual(evaluation.disabledCapabilities, ['projections']);
});
