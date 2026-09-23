import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';
import { recordEmailReaderRefreshReceipt } from '../../src/open-loops/email-reader-refresh-receipt.mjs';

const [stateDir, inputText, mode] = process.argv.slice(2);
if (!stateDir || !inputText) throw new Error('fixture-input-required');
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
const result = recordEmailReaderRefreshReceipt(metadata, JSON.parse(inputText));
metadata.close();
if (mode === 'once') { process.stdout.write(`${result.disposition}\n`); process.exit(0); }
process.stdout.write('pending-persisted\n');
setInterval(() => {}, 1000);
