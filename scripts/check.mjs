import { runRepositoryChecks } from './repository-checks.mjs';

// The first successful packaged-browser capture is frozen in the repository.
// Ordinary checks must now bind the build to that exact baseline identity.
await runRepositoryChecks({ purpose: 'qualification' });
process.stdout.write('Command Center checks passed\n');
