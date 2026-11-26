import { once } from 'node:events';
import { openCommandCenterMetadataService } from '../../src/metadata/service.mjs';

const [stateDir, encoded] = process.argv.slice(2);
const metadata = openCommandCenterMetadataService({ stateDir, capabilities: { notes: true } });
try {
  if (typeof process.send !== 'function') throw new Error('Writer fixture requires IPC.');
  const command = once(process, 'message');
  process.send({ type: 'ready' });
  const [message] = await command;
  if (message?.type !== 'write') throw new Error('Unexpected writer fixture command.');
  try {
    const result = metadata.recordEmailReaderLocator(JSON.parse(encoded));
    process.stdout.write(`${result.disposition}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'unknown'}\n`);
    process.exitCode = 2;
  }
} finally {
  metadata.close();
  if (process.connected) process.disconnect();
}
