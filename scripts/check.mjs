import { runRepositoryChecks } from './repository-checks.mjs';

await runRepositoryChecks();
process.stdout.write('Command Center checks passed\n');
