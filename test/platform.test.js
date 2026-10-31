import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createHarness } from '../src/server.js';
import { LTI, DL, jwtSign, jwtVerify, publicJwk } from '../src/protocol.js';

const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, Connection: 'close' } });
const secret = 'automated-platform-test-token';
const toolKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
let harness, tool, base, toolBase, temp, toolId;
const launches = []; // verified launches received by the fake tool
const pendingLogins = new Map();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
const unescape = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenFields = html => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(m => [unescape(m[1]), unescape(m[2])]));
const formAction = html => unescape(html.match(/<form id="platform-autosubmit" method="post" action="([^"]*)"/)[1]);
async function api(path, data, method = 'POST') {
  return fetch(base + path, { method, headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
async function createLaunch(changes = {}) {
  const r = await api('/api/platform/launches', { toolId, ...changes });
  const text = await r.text();
  assert.equal(r.status, 201, text);
  return JSON.parse(text);
}
// Drives the browser's path: platform start -> tool login -> platform auth -> tool launch.
async function run(launch, { postLogin = true } = {}) {
  const start = await fetch(launch.launchUrl, { redirect: 'manual' });
  let loginRequest;
  if (start.status === 302) loginRequest = { method: 'GET', url: start.headers.get('location') };
  else {
    assert.equal(start.status, 200);
    const html = await start.text();
    loginRequest = { method: 'POST', url: formAction(html), fields: hiddenFields(html) };
  }
  const login = loginRequest.method === 'GET'
    ? await fetch(loginRequest.url, { redirect: 'manual' })
    : await fetch(loginRequest.url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(loginRequest.fields) });
  assert.equal(login.status, 302, await login.text());
  // postLogin: false stops before the authentication request so it can be tampered with.
  if (!postLogin) return { loginRequest, authUrl: login.headers.get('location') };
  const auth = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const authHtml = await auth.text();
  if (auth.status !== 200) return { auth, authHtml, loginRequest, authUrl: login.headers.get('location') };
  const result = await fetch(formAction(authHtml), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(hiddenFields(authHtml)) });
  return { auth, authHtml, loginRequest, launchResponse: result, authUrl: login.headers.get('location') };
}
before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'lti-harness-platform-'));
  tool = http.createServer(async (req, res) => {
    const url = new URL(req.url, toolBase);
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (url.pathname === '/jwks') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ keys: [publicJwk(toolKey, 'tool-key')] })); }
    if (url.pathname === '/login') {
      const input = req.method === 'POST' ? Object.fromEntries(new URLSearchParams(raw)) : Object.fromEntries(url.searchParams);
      const state = randomUUID(); const nonce = randomUUID();
      pendingLogins.set(state, { nonce, input });
      const target = new URL(input.iss + '/platform/auth');
      for (const [k, v] of Object.entries({ scope: 'openid', response_type: 'id_token', response_mode: 'form_post', prompt: 'none', client_id: input.client_id, redirect_uri: toolBase + '/launch', login_hint: input.login_hint, lti_message_hint: input.lti_message_hint, state, nonce })) target.searchParams.set(k, v);
      res.writeHead(302, { Location: target.href }); return res.end();
    }
    if (url.pathname === '/launch') {
      const form = Object.fromEntries(new URLSearchParams(raw));
      const login = pendingLogins.get(form.state);
      if (!login) { res.writeHead(400); return res.end('unknown state'); }
      pendingLogins.delete(form.state);
      try {
        const jwks = await (await fetch(login.input.iss + '/platform/jwks.json')).json();
        const claims = jwtVerify(form.id_token, jwks, { issuer: login.input.iss, audience: login.input.client_id });
        assert.equal(claims.nonce, login.nonce);
        launches.push(claims);
        res.writeHead(200); return res.end(JSON.stringify(claims));
      } catch (err) { res.writeHead(401); return res.end(err.message); }
    }
    res.writeHead(404); res.end();
  });
  toolBase = await listen(tool);
  const reservation = http.createServer(); base = await listen(reservation); await close(reservation);
  harness = createHarness({ baseUrl: base, token: secret, dataDir: temp });
  await new Promise(resolve => harness.server.listen(Number(new URL(base).port), '127.0.0.1', resolve));
  const r = await api('/api/platform/tools', { name: 'Fake tool', loginUrl: toolBase + '/login', redirectUris: [toolBase + '/launch'], jwksUrl: toolBase + '/jwks', clientId: 'tool-client-1', deploymentId: 'deployment-9' });
  const text = await r.text();
  assert.equal(r.status, 201, text);
  toolId = JSON.parse(text).id;
});
after(async () => { await close(harness.server); await close(tool); rmSync(temp, { recursive: true, force: true }); });

test('platform management requires authentication and exposes registration details', async () => {
  assert.equal((await fetch(base + '/api/platform/tools')).status, 401);
  assert.equal((await fetch(base + '/api/platform/launches', { method: 'POST' })).status, 401);
  const info = await (await api('/api/platform', undefined, 'GET')).json();
  assert.equal(info.issuer, base);
  assert.equal(info.authenticationUrl, base + '/platform/auth');
  assert.equal(info.keysetUrl, base + '/platform/jwks.json');
  const jwks = await (await fetch(info.keysetUrl)).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].d, undefined);
  assert.equal((await fetch(info.accessTokenUrl)).status, 501);
  const duplicate = await api('/api/platform/tools', { name: 'Dup', loginUrl: toolBase + '/login', redirectUris: [toolBase + '/launch'], clientId: 'tool-client-1' });
  assert.equal(duplicate.status, 409);
});

test('resource link launch completes the OIDC flow with signed claims', async () => {
  const launch = await createLaunch({ user: { sub: 'user-42', name: 'Ada Lovelace', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.invalid', roles: ['Instructor'] }, custom: { marker: 'abc' }, resourceLink: { id: 'rl-7' } });
  const { launchResponse, loginRequest } = await run(launch);
  assert.equal(loginRequest.fields.iss, base);
  assert.equal(loginRequest.fields.client_id, 'tool-client-1');
  assert.equal(loginRequest.fields.lti_deployment_id, 'deployment-9');
  assert.equal(loginRequest.fields.target_link_uri, toolBase + '/launch');
  assert.equal(launchResponse.status, 200, await launchResponse.clone().text());
  const claims = await launchResponse.json();
  assert.equal(claims.sub, 'user-42');
  assert.equal(claims.email, 'ada@example.invalid');
  assert.equal(claims.aud, 'tool-client-1');
  assert.equal(claims[LTI + 'message_type'], 'LtiResourceLinkRequest');
  assert.equal(claims[LTI + 'deployment_id'], 'deployment-9');
  assert.deepEqual(claims[LTI + 'roles'], ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']);
  assert.equal(claims[LTI + 'resource_link'].id, 'rl-7');
  assert.equal(claims[LTI + 'context'].label, 'HARNESS101');
  assert.equal(claims[LTI + 'custom'].marker, 'abc');
  assert.equal(claims[LTI + 'launch_presentation'].return_url, `${base}/platform/return/${launch.id}`);
  const recorded = await (await api(`/api/platform/launches/${launch.id}`, undefined, 'GET')).json();
  assert.equal(recorded.status, 'token-issued');
  assert.equal(recorded.issuedClaims.sub, 'user-42');
});

test('a launch cannot be authenticated or started twice', async () => {
  const launch = await createLaunch();
  const first = await run(launch);
  assert.equal(first.launchResponse.status, 200);
  const replay = await fetch(first.authUrl, { redirect: 'manual' });
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /expired or already used/);
  assert.equal((await fetch(launch.launchUrl, { redirect: 'manual' })).status, 400);
});

test('authentication requests are validated', async () => {
  const launch = await createLaunch();
  const { authUrl } = await run(launch, { postLogin: false });
  const mutate = (key, value) => { const u = new URL(authUrl); u.searchParams.set(key, value); return u.href; };
  for (const [key, value, pattern] of [['redirect_uri', 'https://evil.example/launch', /redirect_uri is not registered/], ['client_id', 'nobody', /Unknown client_id/], ['login_hint', 'other', /login_hint does not match/], ['lti_message_hint', randomUUID(), /Unknown lti_message_hint/], ['response_mode', 'query', /Unsupported authentication/], ['nonce', '', /Missing or invalid nonce/]]) {
    const r = await fetch(mutate(key, value), { redirect: 'manual' });
    assert.equal(r.status, 400, key);
    assert.match(await r.text(), pattern, key);
  }
  // The launch survived the bad attempts and can still be completed.
  assert.equal((await fetch(authUrl, { redirect: 'manual' })).status, 200);
});

test('claim overrides, removal and invalid signatures', async () => {
  const launch = await createLaunch({ claims: { 'https://example.test/claim': { x: 1 }, [LTI + 'context']: null } });
  const claims = await (await run(launch)).launchResponse.json();
  assert.deepEqual(claims['https://example.test/claim'], { x: 1 });
  assert.equal(claims[LTI + 'context'], undefined);
  const bad = await run(await createLaunch({ signature: 'invalid' }));
  assert.equal(bad.launchResponse.status, 401);
  assert.match(await bad.launchResponse.text(), /Invalid JWT signature/);
});

test('GET login initiation and administrator-only launch creation inputs are validated', async () => {
  const getTool = await (await api('/api/platform/tools', { name: 'GET tool', loginUrl: toolBase + '/login', loginMethod: 'GET', redirectUris: toolBase + '/launch', clientId: 'tool-client-get' })).json();
  const r = await api('/api/platform/launches', { toolId: getTool.id });
  const launch = await r.json();
  const { launchResponse, loginRequest } = await run(launch);
  assert.equal(loginRequest.method, 'GET');
  assert.equal(launchResponse.status, 200);
  for (const bad of [{ messageType: 'Nope' }, { user: { roles: ['Wizard'] } }, { signature: 'maybe' }, { documentTarget: 'tab' }, { toolId: randomUUID() }]) {
    assert.ok((await api('/api/platform/launches', { toolId, ...bad })).status >= 400, JSON.stringify(bad));
  }
});

test('deep linking launch and verified response', async () => {
  const launch = await createLaunch({ messageType: 'LtiDeepLinkingRequest', deepLinking: { accept_multiple: true } });
  const { launchResponse } = await run(launch);
  const claims = await launchResponse.json();
  assert.equal(claims[LTI + 'message_type'], 'LtiDeepLinkingRequest');
  assert.deepEqual(claims[LTI + 'roles'], ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']);
  const settings = claims[DL + 'deep_linking_settings'];
  assert.equal(settings.accept_multiple, true);
  assert.equal(settings.deep_link_return_url, `${base}/platform/deeplink-return/${launch.id}`);
  const respond = (changes = {}, key = toolKey) => {
    const t = Math.floor(Date.now() / 1000);
    return jwtSign({ iss: 'tool-client-1', aud: base, iat: t, exp: t + 300, nonce: randomUUID(), [LTI + 'message_type']: 'LtiDeepLinkingResponse', [LTI + 'version']: '1.3.0', [LTI + 'deployment_id']: 'deployment-9', [DL + 'data']: settings.data, [DL + 'content_items']: [{ type: 'ltiResourceLink', title: 'Chosen', url: toolBase + '/launch' }], ...changes }, key, 'tool-key');
  };
  const post = JWT => fetch(settings.deep_link_return_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ JWT }) });
  assert.match(await (await post(respond({ [DL + 'data']: 'wrong' }))).text(), /data does not match/);
  assert.match(await (await post(respond({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })))).text(), /Invalid JWT signature/);
  assert.match(await (await post(respond({ [LTI + 'message_type']: 'LtiResourceLinkRequest' }))).text(), /Unexpected message type/);
  const ok = await post(respond());
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Deep Linking return verified/);
  const recorded = await (await api(`/api/platform/launches/${launch.id}`, undefined, 'GET')).json();
  assert.equal(recorded.status, 'deep-linking-verified');
  assert.equal(recorded.deepLinkingResult.contentItems[0].title, 'Chosen');
  assert.equal((await post(respond())).status, 400, 'a second response is refused');
});

test('return page records platform messages; tool and launch cleanup via API', async () => {
  const launch = await createLaunch();
  await run(launch);
  const r = await fetch(`${base}/platform/return/${launch.id}?lti_errormsg=Nope&lti_msg=Hello`);
  assert.equal(r.status, 200);
  const recorded = await (await api(`/api/platform/launches/${launch.id}`, undefined, 'GET')).json();
  assert.deepEqual(recorded.returnMessages, { lti_msg: 'Hello', lti_errormsg: 'Nope' });
  assert.equal((await api('/api/platform/launches', undefined, 'DELETE')).status, 200);
  assert.deepEqual(await (await api('/api/platform/launches', undefined, 'GET')).json(), []);
  assert.equal((await api(`/api/platform/tools/${randomUUID()}`, undefined, 'DELETE')).status, 404);
});

test('administration page lists platform mode', async () => {
  const r = await fetch(base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from(`admin:${secret}`).toString('base64') } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Platform mode/);
  assert.match(html, /Register a tool/);
});
