import { parseHostDescriptor } from '../src/host-harness.mjs';
import { readBuiltReceipt } from '../src/build.mjs';
import { assertCandidatePluginPermissions, assertFastHostAdmission } from '../test/support/isolated-acceptance-preflight.mjs';

const descriptor = parseHostDescriptor();
const scenario = process.env.COMMAND_CENTER_ACCEPTANCE_SCENARIO ?? 'release';
if (process.env.COMMAND_CENTER_SEALED_CANDIDATE !== '1') throw new Error('Preflight requires a sealed candidate.');
const host = await assertFastHostAdmission(descriptor, { requireBoundCron: ['release', 'diagnostic-accounted-mixed-email', 'diagnostic-clarification-worker'].includes(scenario) });
const candidate = await assertCandidatePluginPermissions(process.cwd());
const build = await readBuiltReceipt();
process.stdout.write(`isolated-acceptance-preflight=${JSON.stringify({ scenario, host, candidate,
  pluginBuildDigest: build.digest, sealedCandidate: process.env.COMMAND_CENTER_SEALED_CANDIDATE === '1' })}\n`);
