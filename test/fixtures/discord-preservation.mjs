import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createPreservationFixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-center-preservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const files = overrides.files ?? new Map([
    ['channels.json', Buffer.from('[{"id":"fictional-channel","name":"Fictional Garden","type":0}]')],
    ['messages/fictional-channel.jsonl', Buffer.from('{"id":"fictional-message","author":{"id":"fictional-bot","bot":true},"content":"Fictional résumé."}\n')],
    ['attachments/fictional-receipt.txt', Buffer.from('Fictional receipt bytes.\n')]
  ]);
  const summary = Buffer.from(JSON.stringify(overrides.summary ?? { guildTextChannelCount: 1, messageCount: 1, attachmentCount: 1 }));
  const manifest = {
    schemaVersion: 1,
    purpose: 'preservation-only; not a Command Center import',
    baseline: overrides.baseline ?? { guildTextChannelCount: 1, messageCount: 1, attachmentCount: 1 },
    discordRest: { files: [...files].map(([filename, bytes]) => ({ path: filename, bytes: bytes.length, sha256: sha256(bytes) })), summarySha256: sha256(summary), reactionCount: 0 }
  };
  for (const [filename, bytes] of files) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), bytes);
  }
  await writeFile(path.join(root, 'rest-summary.json'), summary);
  await writeFile(path.join(root, 'signing-public.pem'), publicPem);
  async function seal() {
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(root, 'manifest.json'), bytes);
    await writeFile(path.join(root, 'manifest.json.sig'), sign(null, bytes, privateKey));
    return { root, expectedManifestSha256: sha256(bytes), trustedPublicKeySha256: sha256(publicPem) };
  }
  async function replaceFile(filename, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await writeFile(path.join(root, filename), bytes);
    if (filename === 'rest-summary.json') manifest.discordRest.summarySha256 = sha256(bytes);
    else {
      const entry = manifest.discordRest.files.find((item) => item.path === filename);
      if (!entry) throw new Error('Fictional fixture file must already be listed');
      entry.bytes = bytes.length;
      entry.sha256 = sha256(bytes);
      files.set(filename, bytes);
    }
  }
  return { root, manifest, files, seal, replaceFile, options: await seal() };
}
