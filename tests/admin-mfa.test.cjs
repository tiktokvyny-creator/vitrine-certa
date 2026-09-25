'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mfa = require('../assets/admin-mfa.js');

test('mantém apenas fatores TOTP verificados', () => {
  const factors = mfa.verifiedTotpFactors({ data: { totp: [
    { id: 'principal', status: 'verified' },
    { id: 'pendente', status: 'unverified' }, null
  ] } });
  assert.deepEqual(factors, [{ id: 'principal', status: 'verified' }]);
});

test('normaliza o código em seis dígitos', () => {
  assert.equal(mfa.normalizeTotpCode('12 34-56 78'), '123456');
  assert.equal(mfa.normalizeTotpCode(null), '');
});

test('não libera o painel em AAL1 e exige backup em AAL2', () => {
  assert.equal(mfa.decideRoute('aal1', []), 'enroll_primary');
  assert.equal(mfa.decideRoute('aal1', [{ id: 'a' }]), 'challenge');
  assert.equal(mfa.decideRoute('aal2', [{ id: 'a' }]), 'enroll_backup');
  assert.equal(mfa.decideRoute('aal2', [{ id: 'a' }, { id: 'b' }]), 'app');
});
