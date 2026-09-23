import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const [stateDir, encoded] = process.argv.slice(2);
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
try {
  const result = metadata.recordEmailReaderLocator(JSON.parse(encoded));
  process.stdout.write(`${result.disposition}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ?? 'unknown'}\n`);
  process.exitCode = 2;
} finally { metadata.close(); }
