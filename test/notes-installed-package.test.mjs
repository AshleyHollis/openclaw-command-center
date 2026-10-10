import test from 'node:test';

test('enabled TEST Notes package through existing isolated installed-host owners', {
  skip: !process.env.COMMAND_CENTER_NOTES_INSTALLED_MODE && 'Explicit serial installed qualification only', timeout: 600_000
}, async t => {
  const { runNotesInstalledPackageJourney } = await import('./support/notes-installed-package-journey.mjs');
  await runNotesInstalledPackageJourney({ signal: t.signal });
});
