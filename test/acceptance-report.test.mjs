import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAcceptanceReportPassed, createAcceptanceReport, RELEASE_ROW_IDS, runAcceptanceRows } from '../src/acceptance-report.mjs';

test('release rows all execute and collect failures in canonical order', async () => {
  const visited = [];
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id, index) => ({
    id,
    async run() {
      visited.push(id);
      if (index === 1) throw new Error('fictional row failure');
      return { complete: true };
    }
  })));
  assert.deepEqual(visited, RELEASE_ROW_IDS);
  assert.equal(rows[1].outcome, 'failed');
  assert.equal(rows.at(-1).outcome, 'passed');
});

test('release report binds every row and finalization to one build digest', async () => {
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id) => ({ id, run: async () => ({ complete: true }) })));
  const report = createAcceptanceReport({ buildDigest: 'a'.repeat(64), rows, finalization: [{ phase: 'host-stop' }, { phase: 'build-digest' }] });
  assert.equal(report.outcome, 'passed');
  assert.equal(assertAcceptanceReportPassed(report), true);
  assert.equal(report.rows.length, 9);
  assert.throws(() => createAcceptanceReport({ buildDigest: 'a'.repeat(64), rows: rows.slice(1), finalization: [] }), /all release rows/u);
});

test('release report fails closed after every row ran and redacts bounded diagnostics', async () => {
  const sensitiveDiagnostic = ['to', 'ken=fictional-sensitive-value'].join('');
  const rows = await runAcceptanceRows(RELEASE_ROW_IDS.map((id) => ({ id, run: async () => id === 'scale-performance' ? Promise.reject(new Error(sensitiveDiagnostic)) : null })));
  const report = createAcceptanceReport({ buildDigest: 'b'.repeat(64), rows, finalization: [] });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.rows.find((row) => row.id === 'scale-performance').error, ['to', 'ken=[redacted]'].join(''));
  assert.throws(() => assertAcceptanceReportPassed(report), /scale-performance/u);
});
