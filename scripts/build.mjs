import { build } from '../src/build.mjs';

const manifest = await build();
process.stdout.write(`Built Command Center (${manifest.digest})\n`);
