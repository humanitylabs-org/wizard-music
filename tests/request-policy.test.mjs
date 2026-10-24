import test from 'node:test'
import assert from 'node:assert/strict'
import { requestAllowed } from '../server/request-policy.mjs'
const request = (headers, peer = '172.18.0.1') => ({ headers, socket: { remoteAddress: peer } })
test('gateway preserves authority without manual env', () => {
  assert.equal(requestAllowed(request({host:'wizard.example', origin:'https://wizard.example', 'x-forwarded-proto':'https'})), true)
  assert.equal(requestAllowed(request({host:'127.0.0.1:9205', origin:'https://wizard.example', 'x-forwarded-host':'wizard.example', 'x-forwarded-proto':'https'})), true)
})
test('foreign/null/cross-site/malformed origins and untrusted forwarding are denied', () => {
  for (const origin of ['null','https://foreign.example','http://wizard.example']) assert.equal(requestAllowed(request({host:'wizard.example',origin,'x-forwarded-proto':'https'})), false)
  assert.equal(requestAllowed(request({host:'wizard.example',origin:'https://wizard.example','sec-fetch-site':'cross-site','x-forwarded-proto':'https'})),false)
  assert.equal(requestAllowed(request({host:'127.0.0.1:9205',origin:'https://wizard.example','x-forwarded-host':'wizard.example','x-forwarded-proto':'https'}, '203.0.113.1')),false)
  assert.equal(requestAllowed(request({host:'wizard.example,evil.example'})),false)
})
test('box-only no-Origin traffic requires private peer or explicit host', () => {
  assert.equal(requestAllowed(request({host:'127.0.0.1:9205'})),true)
  assert.equal(requestAllowed(request({host:'evil.example'},'203.0.113.1')),false)
})
