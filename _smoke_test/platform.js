// Isolated synthetic platform for manual/browser smoke tests. Not shipped in the image.
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { LTI, DL, AGS, NRPS, SCOPE, jwtSign, jwtVerify, publicJwk, formPost, escapeHTML as e } from '../src/protocol.js';
const tool = process.env.TOOL_URL || 'http://localhost:8089';
const port = Number(process.env.MOCK_PORT || 8092);
const issuer = process.env.MOCK_ISSUER || `http://host.docker.internal:${port}`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const history = [];
const html = (res, content) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html lang="en"><title>Synthetic LTI platform</title><body><h1>Synthetic LTI platform</h1>${content}</body></html>`); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer); let raw = ''; for await (const c of req) raw += c;
  if (url.pathname === '/') return html(res, `<p>For isolated testing only. Register the following platform in the harness:</p><pre>${e(JSON.stringify({ name: 'Browser mock platform', issuer, clientId: 'browser-client', deploymentIds: ['browser-deployment'], authUrl: `http://localhost:${port}/auth`, tokenUrl: issuer + '/token', jwksUrl: issuer + '/jwks' }, null, 2))}</pre>${['LtiResourceLinkRequest', 'LtiDeepLinkingRequest', 'LtiSubmissionReviewRequest', 'invalid-signature'].map(type => `<p><a href="${tool}/lti/login?${new URLSearchParams({ iss: issuer, login_hint: 'synthetic-user', client_id: 'browser-client', target_link_uri: tool + '/lti/launch', lti_message_hint: type })}">${e(type)}</a></p>`).join('')}`);
  if (url.pathname === '/jwks') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ keys: [publicJwk(pem, 'mock-key')] })); }
  if (url.pathname === '/auth') {
    const params = url.searchParams; const t = Math.floor(Date.now() / 1000); const type = params.get('lti_message_hint');
    const claims = { iss: issuer, aud: 'browser-client', sub: type === 'LtiSubmissionReviewRequest' ? 'synthetic-teacher' : 'synthetic-user', iat: t, exp: t + 300, nonce: params.get('nonce'), [LTI + 'version']: '1.3.0', [LTI + 'deployment_id']: 'browser-deployment', [LTI + 'target_link_uri']: tool + '/lti/launch', [LTI + 'message_type']: type === 'invalid-signature' ? 'LtiResourceLinkRequest' : type, [LTI + 'roles']: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], [LTI + 'resource_link']: { id: 'browser-resource' }, [AGS + 'endpoint']: { scope: Object.values(SCOPE).filter(s => !s.includes('nrps')), lineitems: issuer + '/mod/lti/services.php/contexts/1/lineitems?type_id=2', lineitem: issuer + '/mod/lti/services.php/contexts/1/lineitems/1?type_id=2' }, [NRPS + 'namesroleservice']: { context_memberships_url: issuer + '/members', service_versions: ['2.0'] } };
    if (type === 'LtiDeepLinkingRequest') claims[DL + 'deep_linking_settings'] = { accept_types: ['ltiResourceLink'], deep_link_return_url: `http://localhost:${port}/return`, data: 'browser-data' };
    if (type === 'LtiSubmissionReviewRequest') claims[LTI + 'for_user'] = { user_id: 'synthetic-user' };
    let token = jwtSign(claims, pem, 'mock-key');
    if (type === 'invalid-signature') { const parts = token.split('.'); parts[2] = Buffer.alloc(256).toString('base64url'); token = parts.join('.'); }
    return html(res, formPost(tool + '/lti/launch', { state: params.get('state'), id_token: token }));
  }
  if (url.pathname === '/return') {
    try {
      const data = new URLSearchParams(raw);
      const jwks = await (await fetch(tool + '/.well-known/jwks.json')).json();
      const claims = jwtVerify(data.get('JWT'), jwks, { issuer: 'browser-client', audience: issuer });
      return html(res, `<h2>Deep Linking return verified</h2><pre>${e(JSON.stringify(claims, null, 2))}</pre>`);
    } catch { res.statusCode = 400; return html(res, '<h2>Invalid Deep Linking response</h2>'); }
  }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/token') {
    const params = new URLSearchParams(raw);
    try {
      const jwks = await (await fetch(tool + '/.well-known/jwks.json')).json();
      jwtVerify(params.get('client_assertion'), jwks, { issuer: 'browser-client', audience: issuer + '/token' });
      return res.end(JSON.stringify({ access_token: 'synthetic-service-token', token_type: 'Bearer', scope: params.get('scope') }));
    } catch { res.statusCode = 401; return res.end('{}'); }
  }
  if (req.headers.authorization !== 'Bearer synthetic-service-token') { res.statusCode = 401; return res.end('{}'); }
  history.push({ method: req.method, url: req.url, body: raw });
  if (url.pathname === '/members') return res.end(JSON.stringify({ id: issuer + '/members', members: [{ user_id: 'synthetic-user', roles: ['Learner'], name: 'Synthetic Learner' }] }));
  if (req.method === 'POST' && url.pathname.endsWith('/scores')) { res.statusCode = 204; return res.end(); }
  if (req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ id: issuer + '/mod/lti/services.php/contexts/1/lineitems/' + randomUUID() + '?type_id=2', ...JSON.parse(raw) })); }
  return res.end(JSON.stringify(history));
});
server.listen(port, '0.0.0.0', () => console.log(`Synthetic platform http://localhost:${port}; tool ${tool}`));
