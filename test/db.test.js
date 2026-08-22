import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sslConfig } from '../src/db.js';

describe('database TLS configuration', () => {
  it('disables TLS only when explicitly configured', () => {
    assert.equal(sslConfig({ DB_SSL: 'disable' }), false);
  });

  it('rejects unknown TLS modes', () => {
    assert.throws(() => sslConfig({ DB_SSL: 'prefer' }), /disable or verify-full/);
  });

  it('requires a CA bundle for production verification', () => {
    assert.throws(() => sslConfig({ DB_SSL: 'verify-full' }), /DB_CA_PATH/);
  });
});
