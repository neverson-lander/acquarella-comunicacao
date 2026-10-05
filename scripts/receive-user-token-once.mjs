import http from 'node:http';
import { spawn } from 'node:child_process';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 4096) req.destroy();
  });
  req.on('end', () => {
    if (!/^EA[A-Za-z0-9]+$/.test(raw)) {
      res.writeHead(400).end();
      server.close();
      return;
    }
    const child = spawn(process.execPath, ['scripts/configure-messenger-once.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, USER_TOKEN: raw },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    raw = '';
    child.on('exit', code => {
      res.writeHead(code === 0 ? 204 : 500).end();
      server.close();
    });
  });
});

server.listen(3479, '127.0.0.1', () => console.log('ready'));
setTimeout(() => server.close(), 60000).unref();
