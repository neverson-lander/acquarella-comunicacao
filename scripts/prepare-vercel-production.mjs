import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const project = JSON.parse(readFileSync('vercel-app/.vercel/project.json', 'utf8'));
const auth = JSON.parse(readFileSync(process.env.APPDATA + '/com.vercel.cli/Data/auth.json', 'utf8'));
const base = `https://api.vercel.com/v10/projects/${project.projectId}/env?teamId=${project.orgId}`;
const headers = { Authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
const current = await (await fetch(base, { headers })).json();
if (!current.envs) throw new Error('Não foi possível consultar as variáveis da Vercel.');
const db = new DatabaseSync('data/central.sqlite', { readOnly: true });
const tables = ['tenants', 'users', 'accounts', 'conversations', 'messages', 'events', 'jobs', 'audit'];
const snapshot = Object.fromEntries(tables.map(table => [table, db.prepare(`select * from ${table}`).all()]));
db.close();
const values = {
  APP_ENCRYPTION_KEY: readFileSync('data/secret.key').toString('base64'),
  ACQUARELLA_MIGRATION_DATA: gzipSync(JSON.stringify(snapshot)).toString('base64'),
};
for (const [key, value] of Object.entries(values)) {
  if (current.envs.some(e => e.key === key && e.target.includes('production'))) {
    console.log(`${key}: já configurada; preservada.`);
    continue;
  }
  if (Buffer.byteLength(value) > 60000) throw new Error('Snapshot excede limite de variável.');
  const result = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ key, value, type: 'sensitive', target: ['production'] }) });
  if (!result.ok) throw new Error(`Falha ao configurar ${key}: HTTP ${result.status}`);
  console.log(`${key}: configurada como segredo de produção.`);
}
console.log('Snapshot preparado:', JSON.stringify(Object.fromEntries(tables.map(t => [t, snapshot[t].length]))));
