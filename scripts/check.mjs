import { runRepositoryChecks } from './repository-checks.mjs';

// The exact native-workspace performance baseline is intentionally pending
// the first successful packaged-browser capture. Repository safety checks must
// validate the capture prerequisites without claiming release qualification.
await runRepositoryChecks({ purpose: 'capture-prerequisites' });
process.stdout.write('Command Center checks passed\n');
