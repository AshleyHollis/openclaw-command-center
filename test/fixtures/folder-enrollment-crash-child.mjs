import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { withBootstrapNoteFolder } from '../../src/sources/note-folder-identity.mjs';

// Fault injection is confined to this disposable process's filesystem boundary.
// The open and process death are real; no correctness owner is replaced.
const [root, serialized] = process.argv.slice(2);
const options = JSON.parse(serialized);
const writeSync = fs.writeSync.bind(fs);
function interruptMarkerWrite(data) {
  if ((typeof data === 'string' || Buffer.isBuffer(data)) && String(data).includes(options.markerId)) {
    writeSync(1, 'interrupted-before-marker-content\n');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate the fixture');
  }
}
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  const handle = await open(...args);
  const writeFile = handle.writeFile.bind(handle);
  handle.writeFile = (...writeArgs) => { interruptMarkerWrite(writeArgs[0]); return writeFile(...writeArgs); };
  return handle;
};
fs.writeSync = (fd, data, ...args) => { interruptMarkerWrite(data); return writeSync(fd, data, ...args); };
syncBuiltinESMExports();
await withBootstrapNoteFolder(root, { ...options, assertCurrent: () => {} }, () => {
  throw new Error('Fixture reached completion without exercising the interruption boundary');
});
