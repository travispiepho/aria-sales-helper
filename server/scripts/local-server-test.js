import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretsPath = path.join(__dirname, '..', '..', '..', '.env.secrets');
const content = fs.readFileSync(secretsPath, 'utf8');
for (const line of content.split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const idx = line.indexOf('=');
  const k = line.slice(0, idx).trim();
  const v = line.slice(idx + 1).trim();
  if (k) process.env[k] = v;
}
process.env.PORT = process.env.TEST_PORT || '3099';
process.env.NODE_ENV = 'development';
await import('../server.js');
