import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Store {
  constructor(directory, maxLaunches = 500) {
    this.directory = directory;
    this.maxLaunches = maxLaunches;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'state.json');
    if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    else {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.data = { version: 1, kid: randomUUID(), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), platforms: [], consumers: [], pending: {}, replays: {}, launches: [] };
      this.save();
    }
    if (this.data.version !== 1) throw new Error('Unsupported data schema');
  }
  save() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.data.pending)) if (v.expires < now) delete this.data.pending[k];
    for (const [k, v] of Object.entries(this.data.replays)) if (v < now) delete this.data.replays[k];
    this.data.launches = this.data.launches.slice(-this.maxLaunches);
    for (const launch of this.data.launches) launch.actions = launch.actions.slice(-100);
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  addLaunch(launch) {
    const entry = { id: randomUUID(), createdAt: new Date().toISOString(), actions: [], ...launch };
    this.data.launches.push(entry); this.save(); return entry;
  }
}
