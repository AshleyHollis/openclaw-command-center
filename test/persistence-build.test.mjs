import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { build, distRoot } from '../src/build.mjs';

test('production build packages the complete persistence runtime graph without a new SQLite dependency', async () => {
  await build();
  for (const filename of ['compatibility.mjs', 'persistence/service.mjs', 'persistence/runtime-service.mjs', 'persistence/migrations.mjs', 'persistence/validation.mjs', 'persistence/schema.mjs']) await access(new URL(filename, `file://${distRoot}/`));
  const packageJson = await import('../package.json', { with: { type: 'json' } });
  assert.equal(packageJson.default.engines.node, '>=24.0.0');
  assert.equal(Object.hasOwn(packageJson.default.dependencies, 'sqlite'), false);
});
