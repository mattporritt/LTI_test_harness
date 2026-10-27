import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { createHarness } from '../src/server.js';
import { LTI, DL, AGS, NRPS, SCOPE, jwtSign, jwtVerify, jwtParts, publicJwk, oauthSignature, equal } from '../src/protocol.js';

// Restart tests deliberately close listeners; avoid global fetch pool socket reuse.
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, Connection: 'close' } });
const secret = 'automated-harness-test-token';
const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const platformJwks = { keys: [publicJwk(privateKey, 'platform-key')] };
let harness, platform, base, issuer, temp, platformId;
const seen = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
async function api(path, data, method = 'POST', headers = {}) {
  return fetch(base + path, { method, headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
async function post(path, data) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(data), redirect: 'manual' });
}
async function login(messageType = 'LtiResourceLinkRequest', changes = {}) {
  const r = await fetch(`${base}/lti/login?${new URLSearchParams({ iss: issuer, login_hint: 'user-1', client_id: 'client-1', target_link_uri: base + '/lti/launch', lti_message_hint: 'opaque-hint' })}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.searchParams.get('lti_message_hint'), 'opaque-hint');
  assert.equal(u.searchParams.get('response_mode'), 'form_post');
  const t = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: 'client-1', sub: 'user-1', iat: t, exp: t + 300, nonce: u.searchParams.get('nonce'), [LTI + 'deployment_id']: 'deployment-1', [LTI + 'version']: '1.3.0', [LTI + 'message_type']: messageType, [LTI + 'target_link_uri']: base + '/lti/launch', [LTI + 'roles']: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], [LTI + 'resource_link']: { id: 'resource-1' }, [AGS + 'endpoint']: { scope: [SCOPE.lineitem, SCOPE.readonly, SCOPE.score, SCOPE.result], lineitems: issuer + '/mod/lti/services.php/contexts/7/lineitems?type_id=3', lineitem: issuer + '/mod/lti/services.php/contexts/7/lineitems/9?type_id=3' }, [NRPS + 'namesroleservice']: { context_memberships_url: issuer + '/members', service_versions: ['2.0'] }, ...changes };
  return { state: u.searchParams.get('state'), id_token: jwtSign(claims, privateKey, 'platform-key'), claims };
}
async function launch(type, changes) {
  const data = await login(type, changes);
  const r = await post('/lti/launch', { state: data.state, id_token: data.id_token });
  assert.equal(r.status, 303, await r.text());
  return r.headers.get('location').split('/').pop();
}
before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'lti-harness-test-'));
  platform = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, url: req.url, raw, auth: req.headers.authorization, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks') return res.end(JSON.stringify(platformJwks));
    if (req.url === '/token') {
      const params = new URLSearchParams(raw);
      const jwks = await (await fetch(base + '/.well-known/jwks.json')).json();
      const c = jwtVerify(params.get('client_assertion'), jwks, { issuer: 'client-1', audience: issuer + '/token' });
      assert.equal(c.sub, 'client-1'); assert.ok(c.jti);
      assert.equal(params.get('grant_type'), 'client_credentials');
      return res.end(JSON.stringify({ access_token: 'platform-service-token', token_type: 'Bearer', scope: params.get('scope') }));
    }
    if (req.url === '/redirect') { res.writeHead(302, { Location: issuer + '/members' }); return res.end(); }
    if (req.url === '/denied') { res.writeHead(403); return res.end(JSON.stringify({ error: 'permission denied' })); }
    if (req.url === '/outcome') {
      assert.match(req.headers.authorization, /^OAuth /);
      const auth = new URLSearchParams();
      for (const pair of req.headers.authorization.slice(6).split(', ')) { const [k, v] = pair.split('='); auth.set(decodeURIComponent(k), decodeURIComponent(v.slice(1, -1))); }
      assert.equal(auth.get('oauth_body_hash'), createHash('sha1').update(raw).digest('base64'));
      assert.equal(auth.get('oauth_signature'), oauthSignature('POST', issuer + '/outcome', auth, 'shared-secret'));
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<imsx_POXEnvelopeResponse><imsx_codeMajor>success</imsx_codeMajor></imsx_POXEnvelopeResponse>');
    }
    assert.equal(req.headers.authorization, 'Bearer platform-service-token');
    if (req.url === '/members') return res.end(JSON.stringify({ id: issuer + '/members', members: [{ user_id: 'user-1', roles: ['Learner'] }] }));
    if (req.method === 'POST' && req.url.includes('/lineitems?')) { res.writeHead(201); return res.end(JSON.stringify({ id: issuer + '/mod/lti/services.php/contexts/7/lineitems/12?type_id=3', ...JSON.parse(raw) })); }
    if (req.method === 'POST') { res.writeHead(204); return res.end(); }
    return res.end(JSON.stringify([{ id: issuer + '/mod/lti/services.php/contexts/7/lineitems/9?type_id=3', scoreMaximum: 100 }]));
  });
  issuer = await listen(platform);
  // Reserve a real port to make the configured public origin equal the listening origin.
  const reservation = http.createServer(); base = await listen(reservation); await close(reservation);
  harness = createHarness({ baseUrl: base, token: secret, dataDir: temp });
  await new Promise(resolve => harness.server.listen(Number(new URL(base).port), '127.0.0.1', resolve));
  const r = await api('/api/platforms', { name: 'Independent test platform', issuer, clientId: 'client-1', deploymentIds: ['deployment-1'], authUrl: issuer + '/auth', tokenUrl: issuer + '/token', jwksUrl: issuer + '/jwks' });
  assert.equal(r.status, 201); platformId = (await r.json()).id;
});
after(async () => { await close(harness.server); await close(platform); rmSync(temp, { recursive: true, force: true }); });

test('health and public registration do not expose secrets', async () => {
  assert.equal((await fetch(base + '/health')).status, 200);
  const r = await fetch(base + '/registration'); const data = await r.json();
  assert.equal(data.redirect_uris[0], base + '/lti/launch'); assert.ok(!JSON.stringify(data).includes(secret));
  const jwks = await (await fetch(base + '/.well-known/jwks.json')).json(); assert.equal(jwks.keys[0].d, undefined);
});
test('management is authenticated and rejects cross-origin writes', async () => {
  assert.equal((await fetch(base + '/api/launches')).status, 401);
  assert.equal((await api('/api/launches', undefined, 'DELETE', { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await api('/api/launches', undefined, 'DELETE', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('unknown and ambiguous platform registration paths are explicit', async () => {
  assert.equal((await fetch(base + '/lti/login?iss=https://unknown.invalid&login_hint=x')).status, 400);
  const p = harness.store.data.platforms[0];
  assert.equal((await api('/api/platforms', { ...p, deploymentIds: [] })).status, 400);
  assert.equal((await api('/api/platforms', p)).status, 409);
});
test('verified LTI 1.3 launch is inspectable and interactive', async () => {
  const id = await launch(); const record = await (await api('/api/launches/' + id, undefined, 'GET')).json();
  assert.equal(record.claims.sub, 'user-1'); assert.equal(record.platformId, platformId);
  const page = await (await fetch(base + '/session/' + id)).text(); assert.match(page, /Verified launch claims/);
  assert.equal((await (await api(`/api/launches/${id}/actions`, { action: 'answer', answer: '4' })).json()).correct, true);
  assert.equal((await (await api(`/api/launches/${id}/actions`, { action: 'answer', answer: '3' })).json()).correct, false);
});
test('state is one-use even when callbacks arrive concurrently', async () => {
  const data = await login();
  const results = await Promise.all([post('/lti/launch', data), post('/lti/launch', data)]);
  assert.deepEqual(results.map(r => r.status).sort(), [303, 400]);
});
test('expired state and unsafe target are rejected', async () => {
  const data = await login(); harness.store.data.pending[data.state].expires = Date.now() - 1;
  assert.equal((await post('/lti/launch', data)).status, 400);
  assert.equal((await fetch(`${base}/lti/login?${new URLSearchParams({ iss: issuer, login_hint: 'a', target_link_uri: 'https://evil.invalid' })}`)).status, 400);
});
for (const [name, changes] of [
  ['wrong nonce', { nonce: 'wrong' }], ['wrong audience', { aud: 'other' }], ['wrong issuer', { iss: 'https://other.invalid' }],
  ['wrong deployment', { [LTI + 'deployment_id']: 'other' }], ['missing roles', { [LTI + 'roles']: undefined }],
  ['empty subject', { sub: '' }], ['wrong target', { [LTI + 'target_link_uri']: 'https://evil.invalid' }],
  ['expired token', { exp: 1 }], ['missing resource', { [LTI + 'resource_link']: {} }],
  ['multi-audience without azp', { aud: ['client-1', 'other'] }], ['invalid version', { [LTI + 'version']: '2.0.0' }],
]) test(`LTI 1.3 rejects ${name}`, async () => { const data = await login(undefined, changes); assert.equal((await post('/lti/launch', data)).status, 400); });
test('tampered signature and unsupported algorithm are rejected', async () => {
  const data = await login(); const parts = data.id_token.split('.'); parts[1] = Buffer.from(JSON.stringify({ ...data.claims, sub: 'attacker' })).toString('base64url');
  assert.equal((await post('/lti/launch', { state: data.state, id_token: parts.join('.') })).status, 400);
  const other = await login(); const p = other.id_token.split('.'); p[0] = Buffer.from('{"alg":"none"}').toString('base64url');
  assert.equal((await post('/lti/launch', { state: other.state, id_token: p.join('.') })).status, 400);
});
test('Deep Linking response is signed, preserves data, and chooses content', async () => {
  const id = await launch('LtiDeepLinkingRequest', { [DL + 'deep_linking_settings']: { accept_types: ['ltiResourceLink'], deep_link_return_url: issuer + '/return', data: 'opaque<&state' } });
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'deep-link', content: 'quiz', title: '<script>title</script>' })).json();
  const jwks = await (await fetch(base + '/.well-known/jwks.json')).json();
  const claims = jwtVerify(result.JWT, jwks, { issuer: 'client-1', audience: issuer });
  assert.equal(claims[DL + 'data'], 'opaque<&state'); assert.equal(claims[DL + 'content_items'][0].custom.harness_content, 'quiz');
  const r = await post(`/session/${id}/actions`, { action: 'deep-link', content: 'echo' });
  assert.match(await r.text(), /name="JWT"/);
});
test('Deep Linking refuses unaccepted content and unregistered return origin', async () => {
  for (const settings of [{ accept_types: ['html'], deep_link_return_url: issuer + '/return' }, { accept_types: ['ltiResourceLink'], deep_link_return_url: 'https://evil.invalid/return' }]) {
    const id = await launch('LtiDeepLinkingRequest', { [DL + 'deep_linking_settings']: settings });
    assert.equal((await api(`/api/launches/${id}/actions`, { action: 'deep-link' })).status, 400);
  }
});
test('AGS and NRPS requests use scoped tokens and exact legacy URLs', async () => {
  const id = await launch();
  for (const action of ['lineitems', 'members', 'results']) { const r = await api(`/api/launches/${id}/actions`, { action }); assert.equal(r.status, 200); assert.equal((await r.json()).success, true); }
  const r = await api(`/api/launches/${id}/actions`, { action: 'score', scoreGiven: 87 });
  const result = await r.json(); assert.equal(result.response.status, 204);
  assert.equal(result.request.url, issuer + '/mod/lti/services.php/contexts/7/lineitems/9/scores?type_id=3');
  assert.equal(result.request.body.userId, 'user-1'); assert.equal(result.request.body.scoreGiven, 87);
  const captured = seen.findLast(r => r.url.includes('/scores?'));
  assert.equal(captured.headers['content-type'], 'application/vnd.ims.lis.v1.score+json');
});
test('created line item URL and tool key survive a harness restart', async () => {
  const id = await launch();
  assert.equal((await api(`/api/launches/${id}/actions`, { action: 'create-lineitem', label: 'Persistent grade' })).status, 200);
  const before = await (await fetch(base + '/.well-known/jwks.json')).json();
  await close(harness.server);
  // A fresh fetch connection avoids reuse of the socket deliberately closed by restart.
  harness = createHarness({ baseUrl: base, token: secret, dataDir: temp });
  await new Promise(resolve => harness.server.listen(Number(new URL(base).port), '127.0.0.1', resolve));
  assert.deepEqual(await (await fetch(base + '/.well-known/jwks.json', { headers: { Connection: 'close' } })).json(), before);
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'score', scoreGiven: 75 })).json();
  assert.equal(result.request.url, issuer + '/mod/lti/services.php/contexts/7/lineitems/12/scores?type_id=3');
});
test('missing scopes, invalid scores and untrusted services fail before credentials leave', async () => {
  const id = await launch(undefined, { [AGS + 'endpoint']: { scope: [], lineitem: issuer + '/item' } });
  assert.equal((await api(`/api/launches/${id}/actions`, { action: 'score', scoreGiven: 80 })).status, 403);
  for (const scoreGiven of ['', -1, 101, 'NaN']) assert.equal((await api(`/api/launches/${id}/actions`, { action: 'score', scoreGiven })).status, 400);
  const other = await launch(undefined, { [NRPS + 'namesroleservice']: { context_memberships_url: 'https://evil.invalid/steal' } });
  const count = seen.length;
  assert.equal((await api(`/api/launches/${other}/actions`, { action: 'members' })).status, 400);
  assert.equal(seen.length, count);
});
test('redirected service URL is a regression failure and never followed', async () => {
  const id = await launch(undefined, { [NRPS + 'namesroleservice']: { context_memberships_url: issuer + '/redirect' } });
  const count = seen.filter(r => r.url === '/members').length;
  const r = await api(`/api/launches/${id}/actions`, { action: 'members' });
  assert.equal(r.status, 502); assert.match((await r.json()).error, /redirect refused/);
  assert.equal(seen.filter(r => r.url === '/members').length, count);
});
test('service permission errors retain response and explicit failure', async () => {
  const id = await launch(undefined, { [NRPS + 'namesroleservice']: { context_memberships_url: issuer + '/denied' } });
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'members' })).json();
  assert.equal(result.success, false); assert.equal(result.response.status, 403);
});
test('submission review launches preserve for_user and review claims', async () => {
  const id = await launch('LtiSubmissionReviewRequest', { [LTI + 'for_user']: { user_id: 'student-review' }, [LTI + 'roles']: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] });
  const record = await (await api('/api/launches/' + id, undefined, 'GET')).json();
  assert.equal(record.claims[LTI + 'for_user'].user_id, 'student-review');
});
let oauthCounter = 0;
async function legacy(extra = {}, corrupt = false) {
  const input = { lti_message_type: 'basic-lti-launch-request', lti_version: 'LTI-1p0', resource_link_id: 'legacy-1', user_id: 'student-1', roles: 'Learner', oauth_consumer_key: 'legacy-key', oauth_nonce: `oauth-nonce-${++oauthCounter}`, oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_signature_method: 'HMAC-SHA1', lis_outcome_service_url: issuer + '/outcome', lis_result_sourcedid: 'opaque<&id', ...extra };
  input.oauth_signature = corrupt ? 'bad' : oauthSignature('POST', base + '/lti/launch', Object.entries(input), 'shared-secret');
  return { input, response: await post('/lti/launch', input) };
}
test('LTI 1.1 HMAC-SHA1 launch, replay rejection and Basic Outcomes', async () => {
  const r = await api('/api/consumers', { name: 'Legacy', key: 'legacy-key', secret: 'shared-secret', serviceOrigins: [issuer] });
  assert.equal(r.status, 201); assert.equal((await r.json()).secret, '[redacted]');
  const { input, response } = await legacy(); assert.equal(response.status, 303);
  assert.equal((await post('/lti/launch', input)).status, 400);
  const id = response.headers.get('location').split('/').pop();
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'outcome', scoreGiven: 90 })).json();
  assert.equal(result.success, true);
  assert.match(seen.findLast(r => r.url === '/outcome').raw, /<textString>0.9<\/textString>/);
  assert.match(seen.findLast(r => r.url === '/outcome').raw, /opaque&lt;&amp;id/);
  assert.equal((await (await api('/api/consumers', undefined, 'GET')).json())[0].secret, undefined);
});
test('LTI 1.1 rejects wrong secret, stale timestamp and duplicate form keys', async () => {
  assert.equal((await legacy({}, true)).response.status, 400);
  assert.equal((await legacy({ oauth_timestamp: '1' })).response.status, 400);
  const response = await fetch(base + '/lti/launch', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'oauth_nonce=a&oauth_nonce=b' });
  assert.equal(response.status, 400);
});
test('OAuth signature matches the independent RFC 5849 example', () => {
  // RFC 5849 section 3.4.1.1: independent published signature vector.
  const signature = oauthSignature('POST', 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b', [['c2',''],['a3','2 q'],['oauth_consumer_key','9djdj82h48djs9d2'],['oauth_token','kkk9d7dh3k39sjv7'],['oauth_signature_method','HMAC-SHA1'],['oauth_timestamp','137131201'],['oauth_nonce','7d8f3e4a']], 'j49sk3j29djd', 'dh893hdasih9');
  assert.equal(signature, 'r6/TJjbCOr97/+UU0NsvSne7s5g=');
});
test('XML and HTML echoes cannot inject markup', async () => {
  const id = await launch(undefined, { name: '<script>alert(1)</script>' });
  const html = await (await fetch(base + '/session/' + id)).text();
  assert.ok(!html.includes('<script>alert(1)</script>')); assert.match(html, /&lt;script&gt;/);
});


test('submission review finds learner answers and refuses writes as reviewer', async () => {
  const student = await launch();
  await api(`/api/launches/${student}/actions`, { action: 'answer', answer: 4 });
  const review = await launch('LtiSubmissionReviewRequest', { sub: 'teacher-1', [LTI + 'for_user']: { user_id: 'user-1' } });
  const html = await (await fetch(base + '/session/' + review)).text();
  assert.match(html, /Reviewing learner user-1/); assert.match(html, /&quot;correct&quot;: true/);
  assert.ok(!html.includes('Send score for launched user'));
  assert.equal((await api(`/api/launches/${review}/actions`, { action: 'score', scoreGiven: 100 })).status, 403);
});
test('submission review rejects missing learner identity', async () => {
  const data = await login('LtiSubmissionReviewRequest');
  assert.equal((await post('/lti/launch', data)).status, 400);
});
test('pagination preserves the supplied next-page URL and untrusted pages fail', async () => {
  const id = await launch();
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'lineitems', pageUrl: issuer + '/items?cursor=opaque%2Bnext' })).json();
  assert.equal(result.request.url, issuer + '/items?cursor=opaque%2Bnext');
  assert.equal((await api(`/api/launches/${id}/actions`, { action: 'members', pageUrl: 'https://evil.invalid/page' })).status, 400);
});


test('anonymous launches and empty roles are valid but cannot post scores', async () => {
  const id = await launch(undefined, { sub: undefined, [LTI + 'roles']: [] });
  const record = await (await api('/api/launches/' + id, undefined, 'GET')).json();
  assert.equal(record.claims.sub, undefined);
  const r = await api(`/api/launches/${id}/actions`, { action: 'score', scoreGiven: 80 });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Anonymous/);
});
test('anonymous Deep Linking includes review support and respects accept_lineitem', async () => {
  for (const accept_lineitem of [true, false]) {
    const id = await launch('LtiDeepLinkingRequest', { sub: undefined, [LTI + 'roles']: [], [DL + 'deep_linking_settings']: { accept_types: ['ltiResourceLink'], accept_lineitem, deep_link_return_url: issuer + '/return' } });
    const result = await (await api(`/api/launches/${id}/actions`, { action: 'deep-link', content: 'quiz' })).json();
    const item = result.claims[DL + 'content_items'][0];
    if (accept_lineitem) assert.equal(item.lineItem.submissionReview.url, base + '/lti/launch');
    else assert.equal(item.lineItem, undefined);
  }
});
test('submission history never crosses deployments sharing resource IDs', async () => {
  harness.store.data.platforms[0].deploymentIds.push('deployment-2'); harness.store.save();
  const student = await launch();
  await api(`/api/launches/${student}/actions`, { action: 'answer', answer: 4 });
  const review = await launch('LtiSubmissionReviewRequest', { sub: 'teacher-1', [LTI + 'for_user']: { user_id: 'user-1' }, [LTI + 'deployment_id']: 'deployment-2' });
  const html = await (await fetch(base + '/session/' + review)).text();
  assert.match(html, /No locally recorded submissions/);
  assert.ok(!html.includes('&quot;correct&quot;: true'));
});
test('created line item advertises review and selected content changes rendering', async () => {
  const id = await launch(undefined, { [LTI + 'custom']: { harness_content: 'echo' } });
  const html = await (await fetch(base + '/session/' + id)).text();
  assert.match(html, /Claims explorer/); assert.ok(!html.includes('What is 2 + 2?'));
  const result = await (await api(`/api/launches/${id}/actions`, { action: 'create-lineitem' })).json();
  assert.equal(result.request.body.submissionReview.url, base + '/lti/launch');
});
test('primitive JWT payloads are rejected as invalid input', () => {
  assert.throws(() => jwtVerify(jwtSign(null, privateKey, 'platform-key'), platformJwks, { issuer, audience: 'client-1' }), /must be objects/);
});
