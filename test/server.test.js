import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/server.js';

describe('HTTP application', () => {
  let server;
  let baseUrl;
  let messages;

  beforeEach(async () => {
    messages = [];
    const db = {
      async isReady() {},
      async listMessages() { return [...messages].reverse(); },
      async createMessage(author, body) {
        const message = { id: messages.length + 1, author, body, created_at: new Date().toISOString() };
        messages.push(message);
        return message;
      }
    };
    server = createApp({ db, logger: { error() {} } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('serves the site with security headers', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /AWS MiniFlow/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  });

  it('reports liveness and database readiness separately', async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.deepEqual(await live.json(), { status: 'ok' });
    assert.deepEqual(await ready.json(), { status: 'ready' });
  });

  it('creates and reads a validated message', async () => {
    const created = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: ' Codex ', body: ' deployment works ' })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).message.body, 'deployment works');

    const listed = await fetch(`${baseUrl}/api/messages`);
    const result = await listed.json();
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].author, 'Codex');
  });

  it('rejects invalid input and unsupported media types', async () => {
    const invalid = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: '', body: 'hello' })
    });
    assert.equal(invalid.status, 422);

    const unsupported = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello'
    });
    assert.equal(unsupported.status, 415);
  });

  it('rejects malformed JSON', async () => {
    const response = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    assert.equal(response.status, 400);
  });
});
