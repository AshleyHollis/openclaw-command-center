import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { recordEmailReaderRefreshReceipt } from '../../src/open-loops/email-reader-refresh-receipt.mjs';

const [stateDir, inputText, mode] = process.argv.slice(2);
if (!stateDir || !inputText) throw new Error('fixture-input-required');
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
const commit = () => {
  const result = recordEmailReaderRefreshReceipt(metadata, JSON.parse(inputText));
  metadata.close();
  process.stdout.write(`${mode === 'barrier' || mode === 'once' ? result.disposition : 'pending-persisted'}\n`);
  if (mode === 'barrier' || mode === 'once') process.exit(0);
  setInterval(() => {}, 1000);
};
if (mode === 'barrier') {
  process.stdout.write('ready\n');
  process.stdin.once('data', commit);
} else commit();
