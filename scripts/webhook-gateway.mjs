import http from 'node:http';
import { readFileSync } from 'node:fs';

// Apenas callbacks Meta e páginas públicas de privacidade. Painel permanece local.
const port = Number(process.env.WEBHOOK_PORT || 3002);
const upstreamPort = Number(process.env.PORT || 3000);
const maximumBody = 1024 * 1024;

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const path = request.url.split('?')[0];
  const publicFiles = {
    '/privacidade': ['privacy.html', 'text/html; charset=utf-8'],
    '/exclusao-de-dados': ['data-deletion.html', 'text/html; charset=utf-8'],
    '/privacy.css': ['privacy.css', 'text/css; charset=utf-8'],
  };
  if (publicFiles[path]) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const [file, type] = publicFiles[path];
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const content = readFileSync(new URL('../public/' + file, import.meta.url));
      response.writeHead(200, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(503).end('Temporarily unavailable');
    }
    return;
  }
  if (!/^\/webhooks\/meta\/[a-f0-9-]{36}$/.test(path)) {
    response.writeHead(404).end('Not found');
    return;
  }
  if (!['GET', 'POST'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, POST' }).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximumBody) {
        response.writeHead(413).end('Payload too large');
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    if (!response.destroyed) response.writeHead(400).end();
    return;
  }
  const headers = {};
  for (const name of ['content-type', 'x-hub-signature-256']) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, path: request.url,
    method: request.method, headers, timeout: 20000,
  }, result => {
    response.writeHead(result.statusCode, {
      'Content-Type': result.headers['content-type'] || 'text/plain',
    });
    result.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502).end('Upstream unavailable');
    else response.destroy();
  });
  response.on('close', () => upstream.destroy());
  upstream.end(Buffer.concat(chunks));
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log(`Webhook gateway: http://127.0.0.1:${port}`));
