import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Development-only preload. Deployment entry points keep explicit environment
// configuration, and demo scripts continue to use their isolated fixture env.
let contents;
try { if (process.env.AEEIS_DEMO_MODE !== '1') contents = readFileSync('.env', 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

if (contents !== undefined) {
  for (const [name, value] of Object.entries(parseEnv(contents))) {
    const supported = name.startsWith('AEEIS_') || name.startsWith('TEMPORAL_')
      || name === 'DATABASE_URL' || name === 'DATABASE_URL_FILE' || name === 'PORT';
    // Empty template entries are unconfigured; explicit process values win.
    if (supported && value.trim() && process.env[name] === undefined) process.env[name] = value;
  }
}
