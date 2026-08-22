import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 8 * 1024;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

async function readJson(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid JSON');
    error.status = 400;
    throw error;
  }
}

function cleanMessage(input) {
  const author = typeof input?.author === 'string' ? input.author.trim() : '';
  const body = typeof input?.body === 'string' ? input.body.trim() : '';

  if (!author || author.length > 40) {
    return { error: '名称长度必须为 1–40 个字符。' };
  }
  if (!body || body.length > 280) {
    return { error: '消息长度必须为 1–280 个字符。' };
  }
  return { author, body };
}

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'styles.css', 'app.js'].includes(relative)) return false;

  const data = await readFile(join(PUBLIC_DIR, relative));
  send(response, 200, data, {
    'Content-Type': MIME[extname(relative)] ?? 'application/octet-stream',
    'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=3600'
  });
  return true;
}

export function createApp({ db, logger = console } = {}) {
  if (!db) throw new Error('db is required');

  return http.createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] ?? randomUUID();
    response.setHeader('X-Request-Id', requestId);

    try {
      const url = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/health/live') {
        return sendJson(response, 200, { status: 'ok' });
      }

      if (request.method === 'GET' && url.pathname === '/health/ready') {
        await db.isReady();
        return sendJson(response, 200, { status: 'ready' });
      }

      if (request.method === 'GET' && url.pathname === '/api/messages') {
        const messages = await db.listMessages();
        return sendJson(response, 200, { messages });
      }

      if (request.method === 'POST' && url.pathname === '/api/messages') {
        if (!request.headers['content-type']?.startsWith('application/json')) {
          return sendJson(response, 415, { error: 'Content-Type 必须为 application/json。' });
        }

        const message = cleanMessage(await readJson(request));
        if (message.error) return sendJson(response, 422, message);

        const created = await db.createMessage(message.author, message.body);
        return sendJson(response, 201, { message: created });
      }

      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      logger.error(JSON.stringify({
        level: 'error',
        requestId,
        message: error.message
      }));
      return sendJson(response, error.status ?? 500, {
        error: error.status ? error.message : 'internal server error',
        requestId
      });
    }
  });
}

export async function start(env = process.env) {
  const db = createDatabase(env);
  await db.migrate();

  const server = createApp({ db });
  const port = Number(env.PORT ?? 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', message: 'server started', port }));
  });

  const shutdown = () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return { server, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error(JSON.stringify({ level: 'fatal', message: error.message }));
    process.exit(1);
  });
}

export { cleanMessage, readJson };
