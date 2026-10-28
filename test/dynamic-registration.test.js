import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createHarness } from '../src/server.js';
import { dynamicRegistration, TOOL_CONFIG, PLATFORM_CONFIG } from '../src/registration.js';
import { LTI, SCOPE, jwtSign, publicJwk } from '../src/protocol.js';

const secret = 'dynamic-registration-test-admin';
const registrationToken = 'short-lived-platform-secret';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { Connection: 'close', ...init.headers }, redirect: 'manual' });
let h, platform, base, issuer, dir, mode, calls, counter = 0;
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
function config() {
  return { issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', registration_endpoint: issuer + '/register', response_types_supported: ['id_token'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['private_key_jwt'], [PLATFORM_CONFIG]: { product_family_code: 'independent-fixture', version: '1', messages_supported: [{ type: 'LtiResourceLinkRequest' }] } };
}
async function api(path, data, auth = true, extra = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${secret}` } : {}), ...extra }, body: JSON.stringify(data) });
}
async function issue() {
  const r = await api('/api/registration-links', { origins: [issuer], name: 'Dynamic test tool' });
  assert.equal(r.status, 201); return (await r.json()).url;
}
async function initiate(url, token = registrationToken, discovery = issuer + '/discovery') {
  const u = new URL(url); u.searchParams.set('openid_configuration', discovery);
  if (token !== undefined) u.searchParams.set('registration_token', token);
  return fetch(u);
}
const complete = url => fetch(url, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lti-dynamic-test-'));
  platform = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, raw });
    res.setHeader('Content-Type', 'application/json');
    if (['/discovery', '/tenant-discovery', '/tenant/discovery'].includes(req.url.split('?')[0])) {
      let c = config();
      if (['issuer', 'nested'].includes(mode)) c.issuer = issuer + '/tenant';
      if (mode === 'endpoint') c.registration_endpoint = 'https://unapproved.invalid/steal';
      if (mode === 'issuer-origin') c.issuer = 'https://unapproved.invalid';
      if (mode === 'unsupported') c.response_types_supported = ['code'];
      if (mode === 'redirect') { res.writeHead(302, { Location: issuer + '/discovery' }); return res.end(); }
      if (mode === 'invalid-json') return res.end('not json');
      return res.end(JSON.stringify(c));
    }
    if (req.url === '/register') {
      if (mode === 'denied') { res.writeHead(401); return res.end(JSON.stringify({ error: registrationToken })); }
      const m = JSON.parse(raw);
      assert.equal(m.application_type, 'web'); assert.deepEqual(m.response_types, ['id_token']);
      assert.deepEqual(m.grant_types, ['implicit', 'client_credentials']);
      assert.equal(m.jwks_uri, base + '/.well-known/jwks.json');
      assert.equal(m[TOOL_CONFIG].domain, new URL(base).host);
      assert.equal(m.token_endpoint_auth_method, 'private_key_jwt');
      assert.ok(Object.values(SCOPE).every(s => m.scope.split(' ').includes(s)));
      assert.ok(m[TOOL_CONFIG].messages.some(m => m.type === 'LtiDeepLinkingRequest' && m.supported_types.includes('ltiResourceLink')));
      const response = { ...m, client_id: `dynamic-${++counter}`, scope: SCOPE.score, registration_access_token: 'must-not-be-persisted' };
      if (mode !== 'no-deployment') response[TOOL_CONFIG].deployment_id = mode === 'bad-deployment' ? 42 : 'deployment-1';
      if (mode === 'no-client') delete response.client_id;
      res.writeHead(201); return res.end(JSON.stringify(response));
    }
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [publicJwk(privateKey, 'platform')] }));
    res.writeHead(404); res.end('{}');
  });
  issuer = await listen(platform);
  const reserve = http.createServer(); base = await listen(reserve); await close(reserve);
  h = createHarness({ baseUrl: base, token: secret, dataDir: dir });
  await new Promise(resolve => h.server.listen(Number(new URL(base).port), '127.0.0.1', resolve));
});
beforeEach(() => { mode = ''; calls = []; });
after(async () => { await close(h.server); await close(platform); rmSync(dir, { recursive: true, force: true }); });

test('only an authenticated same-origin operator can issue scoped links', async () => {
  assert.equal((await api('/api/registration-links', { origins: [issuer] }, false)).status, 401);
  assert.equal((await api('/api/registration-links', { origins: [issuer] }, true, { Origin: 'https://evil.invalid' })).status, 403);
  for (const origins of [[], ['file:///etc/passwd'], [issuer + '/path'], [issuer + '?q=1']]) assert.equal((await api('/api/registration-links', { origins })).status, 400);
  assert.equal(calls.length, 0);
});
test('initiation is a confirmation page; tokens are not exposed and cross-origin completion fails', async () => {
  const url = await issue(); const r = await initiate(url);
  assert.equal(r.status, 200); const html = await r.text();
  assert.match(html, /Confirm dynamic registration/); assert.ok(!html.includes(registrationToken));
  assert.equal(calls.length, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: issuer } })).status, 403);
  assert.equal(calls.length, 0);
});
test('discovery origin, duplicate parameters and rebinding are rejected before fetching', async () => {
  const url = await issue(); assert.equal((await initiate(url, registrationToken, 'https://evil.invalid/config')).status, 400);
  const u = new URL(url); u.searchParams.append('openid_configuration', issuer + '/discovery'); u.searchParams.append('openid_configuration', issuer + '/other');
  assert.equal((await fetch(u)).status, 400);
  assert.equal((await initiate(url)).status, 200);
  assert.equal((await initiate(url, 'different-token')).status, 400);
  const bad = await issue(); assert.equal((await initiate(bad, 'bad\r\ntoken')).status, 400);
  assert.equal(calls.length, 0);
});
test('registration exchanges actual JSON, saves client/deployment and permits signed launch', async () => {
  const url = await issue(); await initiate(url);
  const results = await Promise.all([complete(url), complete(url)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 410]);
  const success = results.find(r => r.status === 200); const html = await success.text();
  assert.match(html, /Dynamic registration complete/); assert.match(html, /registration-close.js/);
  assert.equal(calls.filter(c => c.path === '/register').length, 1);
  assert.equal(calls.find(c => c.path === '/register').auth, `Bearer ${registrationToken}`);
  assert.equal(calls.find(c => c.path === '/discovery').auth, undefined);
  const p = h.store.data.platforms.at(-1);
  assert.deepEqual(p.deploymentIds, ['deployment-1']); assert.equal(p.dynamicRegistration.grantedScopes, SCOPE.score);
  assert.ok(!readFileSync(h.store.file, 'utf8').includes(registrationToken));
  assert.ok(!readFileSync(h.store.file, 'utf8').includes('must-not-be-persisted'));
  assert.ok(!html.includes('must-not-be-persisted'));
  const login = await fetch(base + '/lti/login?' + new URLSearchParams({ iss: issuer, client_id: p.clientId, login_hint: 'learner', target_link_uri: base + '/lti/launch' }));
  assert.equal(login.status, 302); const auth = new URL(login.headers.get('location')); const t = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: p.clientId, iat: t, exp: t + 60, sub: 'learner', nonce: auth.searchParams.get('nonce'), [LTI+'deployment_id']: 'deployment-1', [LTI+'version']: '1.3.0', [LTI+'message_type']: 'LtiResourceLinkRequest', [LTI+'resource_link']: { id: 'resource-1' }, [LTI+'roles']: ['Learner'], [LTI+'target_link_uri']: base + '/lti/launch' };
  const launch = await fetch(base + '/lti/launch', { method: 'POST', body: new URLSearchParams({ state: auth.searchParams.get('state'), id_token: jwtSign(claims, privateKey, 'platform') }) });
  assert.equal(launch.status, 303);
});
test('an absent optional registration token sends no Authorization header', async () => {
  const url = await issue(); const u = new URL(url); u.searchParams.set('openid_configuration', issuer + '/discovery');
  await fetch(u); assert.equal((await complete(url)).status, 200);
  assert.equal(calls.find(c => c.path === '/register').auth, undefined);
});
for (const failure of ['issuer', 'issuer-origin', 'endpoint', 'unsupported', 'redirect', 'invalid-json']) test(`unsafe discovery ${failure} aborts before registration`, async () => {
  mode = failure; const url = await issue(); await initiate(url, registrationToken, issuer + (failure === 'issuer' ? '/tenant-discovery' : '/discovery')); const r = await complete(url);
  assert.ok([400, 502].includes(r.status)); assert.equal(calls.filter(c => c.path === '/register').length, 0);
  assert.equal((await complete(url)).status, 410);
});
for (const failure of ['denied', 'no-client', 'bad-deployment']) test(`response ${failure} saves no platform and leaks no token`, async () => {
  mode = failure; const count = h.store.data.platforms.length; const url = await issue(); await initiate(url);
  const r = await complete(url); assert.equal(r.status, 502); const text = await r.text();
  assert.ok(!text.includes(registrationToken)); assert.match(text, /registration-close/); assert.equal(h.store.data.platforms.length, count);
});
test('missing deployment is persisted pending and only authenticated completion enables it', async () => {
  mode = 'no-deployment'; const url = await issue(); await initiate(url); assert.equal((await complete(url)).status, 200);
  const p = h.store.data.platforms.at(-1); assert.deepEqual(p.deploymentIds, []); assert.equal(p.dynamicRegistration.deploymentPending, true);
  const login = await fetch(base + '/lti/login?' + new URLSearchParams({ iss: issuer, client_id: p.clientId, login_hint: 'learner', target_link_uri: base + '/lti/launch' }));
  const auth = new URL(login.headers.get('location')); const t = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: p.clientId, iat: t, exp: t + 60, sub: 'learner', nonce: auth.searchParams.get('nonce'), [LTI+'deployment_id']: 'untrusted-first-deployment', [LTI+'version']: '1.3.0', [LTI+'message_type']: 'LtiResourceLinkRequest', [LTI+'resource_link']: { id: 'resource' }, [LTI+'roles']: ['Learner'], [LTI+'target_link_uri']: base + '/lti/launch' };
  const blocked = await fetch(base + '/lti/launch', { method: 'POST', body: new URLSearchParams({ state: auth.searchParams.get('state'), id_token: jwtSign(claims, privateKey, 'platform') }) });
  assert.equal(blocked.status, 400); assert.match(await blocked.text(), /Deployment mismatch/);
  const path = `/api/platforms/${p.id}/deployments`;
  assert.equal((await api(path, { deploymentIds: ['later'] }, false)).status, 401);
  assert.equal((await api(path, { deploymentIds: [] })).status, 400);
  assert.equal((await api(path, { deploymentIds: ['later'] })).status, 200);
  assert.deepEqual(p.deploymentIds, ['later']); assert.equal(p.dynamicRegistration.deploymentPending, false);
  const restarted = createHarness({ baseUrl: base, token: secret, dataDir: dir });
  assert.deepEqual(restarted.store.data.platforms.at(-1).deploymentIds, ['later']);
});
test('unknown, uninitiated and expired tickets cannot make network calls', async () => {
  assert.equal((await complete(base + '/lti/register/unknown')).status, 410);
  const url = await issue(); assert.equal((await complete(url)).status, 400); assert.equal(calls.length, 0);
  let time = 1; const d = dynamicRegistration({ base, clock: () => time });
  const ticket = d.issue({ origins: [issuer] }); time += 600001;
  assert.throws(() => d.initiate(ticket.url.split('/').pop(), new URLSearchParams({ openid_configuration: issuer + '/discovery' })), /expired/);
});

test('issuer subpaths and discovery query parameters are preserved', async () => {
  mode = 'nested'; const url = await issue();
  await initiate(url, registrationToken, issuer + '/tenant/discovery?registration=opaque');
  assert.equal((await complete(url)).status, 200);
  assert.equal(h.store.data.platforms.at(-1).issuer, issuer + '/tenant');
  assert.equal(calls[0].path, '/tenant/discovery?registration=opaque');
});
