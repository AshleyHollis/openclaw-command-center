import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Shared observable scenarios. Fixtures supply real owners, not mocked correctness. */
export function conditionalOwnerContract(test, name, setup) {
  test(`${name}: stale-base preserves the competing writer`, async (t) => {
    const owner = await setup(t);
    const base = await owner.read();
    await owner.write(owner.command(base.revision, '08:15', randomUUID()));
    const newer = await owner.read();
    await assert.rejects(owner.write(owner.command(base.revision, '09:30', randomUUID())), { code: 'conflict' });
    assert.deepEqual(await owner.read(), newer);
  });
  test(`${name}: changed intent cannot reuse an operation ID`, async (t) => {
    const owner = await setup(t);
    const base = await owner.read(); const id = randomUUID();
    await owner.write(owner.command(base.revision, '08:15', id));
    await assert.rejects(owner.write(owner.command(base.revision, '09:30', id)), { code: 'intent-mismatch' });
    assert.equal((await owner.read()).value, '08:15');
  });
  test(`${name}: exact replay after reopen preserves the original receipt, not a newer revision`, async (t) => {
    const owner = await setup(t);
    const base = await owner.read(); const command = owner.command(base.revision, '08:15', randomUUID());
    const receipt = await owner.write(command);
    await owner.reopen();
    assert.deepEqual(await owner.write(command), receipt);
    const current = await owner.read();
    await owner.write(owner.command(current.revision, '09:30', randomUUID()));
    const newer = await owner.read();
    assert.deepEqual(await owner.write(command), receipt);
    assert.deepEqual(await owner.read(), newer);
  });
  test(`${name}: two independent owners sharing a base cannot both commit`, async (t) => {
    const owner = await setup(t);
    const base = await owner.read(); const competitor = await owner.competitor();
    const results = await Promise.allSettled([
      owner.write(owner.command(base.revision, '08:15', randomUUID())),
      competitor.write(owner.command(base.revision, '09:30', randomUUID()))
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'conflict');
    assert.equal((await owner.read()).revision, base.revision + 1);
  });
}
