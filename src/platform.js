import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { LTI, DL, insist, webURL, jwtSign, jwtVerify, publicJwk, escapeHTML as e } from './protocol.js';

// Platform (LTI consumer) mode: the harness plays the LMS side of an LTI 1.3 exchange so that a
// tool under test can be launched from it. Supported messages: LtiResourceLinkRequest and
// LtiDeepLinkingRequest, plus verification of the tool's Deep Linking response.
export const PLATFORM_MESSAGES = ['LtiResourceLinkRequest', 'LtiDeepLinkingRequest'];
const MEMBERSHIP = 'http://purl.imsglobal.org/vocab/lis/v2/membership#';
const ROLES = {
  Learner: MEMBERSHIP + 'Learner',
  Instructor: MEMBERSHIP + 'Instructor',
  ContentDeveloper: MEMBERSHIP + 'ContentDeveloper',
  Mentor: MEMBERSHIP + 'Mentor',
  Administrator: 'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
};
const COURSE_OFFERING = 'http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering';
const LAUNCH_TTL_MS = 10 * 60 * 1000;
const MAX_LAUNCHES = 500;
const list = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).map(s => String(s).trim()).filter(Boolean);
const text = (value, name, max = 255) => {
  insist(typeof value === 'string' && value.length > 0 && value.length <= max, `Missing or invalid ${name}`);
  return value;
};
const object = (value, name) => {
  insist(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value;
};
function roleUri(role) {
  if (/^(https?|urn):/.test(role)) return role;
  insist(ROLES[role], `Unknown role "${role}"; use a full role URI or one of ${Object.keys(ROLES).join(', ')}`);
  return ROLES[role];
}
let wrongKey;
const wrongPrivateKey = () => (wrongKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

export function platformMode({ base, data, save, requestJSON, authorize, checkOrigin, body, page, json, pretty }) {
  data.tools ||= [];
  data.platformLaunches ||= [];
  const endpoint = path => `${base}${path}`;
  const info = () => ({
    issuer: base,
    authenticationUrl: endpoint('/platform/auth'),
    keysetUrl: endpoint('/platform/jwks.json'),
    accessTokenUrl: endpoint('/platform/token'),
    note: 'Platform services (AGS, NRPS) are not implemented; the access token URL returns 501.',
  });
  const autoForm = (action, fields, label) => `<form id="platform-autosubmit" method="post" action="${e(action)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('')}<button>${e(label)}</button></form><script src="/platform.js"></script>`;

  function addTool(input) {
    const name = text(input.name, 'name');
    const loginUrl = webURL(text(input.loginUrl, 'loginUrl')).href;
    const redirectUris = list(input.redirectUris);
    insist(redirectUris.length > 0, 'At least one redirect URI is required');
    redirectUris.forEach(uri => webURL(uri));
    const targetLinkUri = webURL(input.targetLinkUri || redirectUris[0]).href;
    const deepLinkUrl = input.deepLinkUrl ? webURL(input.deepLinkUrl).href : targetLinkUri;
    const jwksUrl = input.jwksUrl ? webURL(input.jwksUrl).href : '';
    const loginMethod = String(input.loginMethod || 'POST').toUpperCase();
    insist(['GET', 'POST'].includes(loginMethod), 'loginMethod must be GET or POST');
    const clientId = input.clientId ? text(input.clientId, 'clientId') : `harness-${randomUUID()}`;
    insist(!data.tools.some(t => t.clientId === clientId), 'Client ID already registered', 409);
    const origins = [...new Set([loginUrl, ...redirectUris, targetLinkUri, deepLinkUrl, jwksUrl, ...list(input.serviceOrigins)].filter(Boolean).map(s => webURL(s).origin))];
    const tool = { id: randomUUID(), name, clientId, deploymentId: text(String(input.deploymentId || '1'), 'deploymentId'), loginUrl, loginMethod, redirectUris, targetLinkUri, deepLinkUrl, jwksUrl, origins, createdAt: new Date().toISOString() };
    data.tools.push(tool); save();
    return tool;
  }

  function addLaunch(input) {
    const tool = data.tools.find(t => t.id === input.toolId);
    insist(tool, 'Tool not found', 404);
    const messageType = input.messageType || 'LtiResourceLinkRequest';
    insist(PLATFORM_MESSAGES.includes(messageType), `messageType must be one of ${PLATFORM_MESSAGES.join(', ')}`);
    const deep = messageType === 'LtiDeepLinkingRequest';
    const user = object(input.user ?? {}, 'user');
    const roles = list(user.roles);
    const spec = {
      user: {
        sub: text(String(user.sub ?? user.id ?? 'harness-user-1'), 'user.sub'),
        name: user.name ?? 'Harness User',
        given_name: user.given_name ?? 'Harness',
        family_name: user.family_name ?? 'User',
        email: user.email ?? 'harness.user@example.invalid',
        ...(user.picture ? { picture: webURL(user.picture).href } : {}),
        roles: (roles.length ? roles : [deep ? 'Instructor' : 'Learner']).map(roleUri),
      },
      context: input.context === null ? null : { id: 'harness-context-1', label: 'HARNESS101', title: 'Harness test course', ...object(input.context ?? {}, 'context') },
      resourceLink: { id: 'harness-resource-1', title: 'Harness resource', ...object(input.resourceLink ?? {}, 'resourceLink') },
      targetLinkUri: webURL(input.targetLinkUri || (deep ? tool.deepLinkUrl : tool.targetLinkUri)).href,
      custom: object(input.custom ?? {}, 'custom'),
      claims: object(input.claims ?? {}, 'claims'),
      deepLinking: object(input.deepLinking ?? {}, 'deepLinking'),
      documentTarget: input.documentTarget || 'window',
      signature: input.signature || 'valid',
    };
    insist(['valid', 'invalid'].includes(spec.signature), 'signature must be valid or invalid');
    insist(['window', 'iframe', 'embed'].includes(spec.documentTarget), 'documentTarget must be window, iframe or embed');
    const launch = { id: randomUUID(), toolId: tool.id, messageType, spec, loginHint: randomUUID(), dlData: deep ? randomUUID() : undefined, status: 'created', createdAt: new Date().toISOString(), expires: Date.now() + LAUNCH_TTL_MS };
    data.platformLaunches.push(launch);
    if (data.platformLaunches.length > MAX_LAUNCHES) data.platformLaunches.splice(0, data.platformLaunches.length - MAX_LAUNCHES);
    save();
    return launch;
  }
  const view = l => ({ id: l.id, toolId: l.toolId, messageType: l.messageType, status: l.status, createdAt: l.createdAt, expiresAt: new Date(l.expires).toISOString(), launchUrl: endpoint(`/platform/launch/${l.id}`), spec: l.spec, issuedClaims: l.issuedClaims, deepLinkingResult: l.deepLinkingResult, returnMessages: l.returnMessages });

  function buildClaims(l, tool, nonce) {
    const { spec } = l; const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: base, aud: tool.clientId, sub: spec.user.sub, iat, exp: iat + 300, nonce,
      name: spec.user.name, given_name: spec.user.given_name, family_name: spec.user.family_name, email: spec.user.email,
      ...(spec.user.picture ? { picture: spec.user.picture } : {}),
      [LTI + 'deployment_id']: tool.deploymentId, [LTI + 'version']: '1.3.0', [LTI + 'message_type']: l.messageType,
      [LTI + 'target_link_uri']: spec.targetLinkUri, [LTI + 'roles']: spec.user.roles,
      [LTI + 'tool_platform']: { guid: new URL(base).host, name: 'LTI test harness platform', product_family_code: 'lti-test-harness', version: '0.1.0' },
      [LTI + 'launch_presentation']: { document_target: spec.documentTarget, return_url: endpoint(`/platform/return/${l.id}`) },
      ...(Object.keys(spec.custom).length ? { [LTI + 'custom']: spec.custom } : {}),
      ...(spec.context ? { [LTI + 'context']: { type: [COURSE_OFFERING], ...spec.context } } : {}),
    };
    if (l.messageType === 'LtiResourceLinkRequest') claims[LTI + 'resource_link'] = spec.resourceLink;
    else {
      claims[DL + 'deep_linking_settings'] = {
        accept_types: ['ltiResourceLink'], accept_presentation_document_targets: ['iframe', 'window'], accept_multiple: false, auto_create: false,
        ...spec.deepLinking, deep_link_return_url: endpoint(`/platform/deeplink-return/${l.id}`), data: l.dlData,
      };
    }
    for (const [key, value] of Object.entries(spec.claims)) { if (value === null) delete claims[key]; else claims[key] = value; }
    return claims;
  }

  async function verifyDeepLinkReturn(l, tool, input) {
    insist(l.status === 'token-issued', 'Launch is not awaiting a Deep Linking response');
    insist(tool.jwksUrl, 'The tool has no public keyset URL registered, so its response cannot be verified');
    insist(typeof input.JWT === 'string', 'Missing JWT');
    const jwks = await requestJSON(tool.jwksUrl, {}, tool.origins);
    const claims = jwtVerify(input.JWT, jwks, { issuer: tool.clientId, audience: base });
    insist(claims.nonce && typeof claims.nonce === 'string', 'Missing nonce');
    insist(claims[LTI + 'message_type'] === 'LtiDeepLinkingResponse', 'Unexpected message type');
    insist(claims[LTI + 'version'] === '1.3.0', 'Invalid LTI version');
    insist(claims[LTI + 'deployment_id'] === tool.deploymentId, 'Deployment mismatch');
    insist(claims[DL + 'data'] === l.dlData, 'Deep Linking data does not match the request');
    const items = claims[DL + 'content_items'] ?? [];
    insist(Array.isArray(items) && items.every(item => item && typeof item === 'object' && typeof item.type === 'string'), 'Invalid content_items');
    l.status = 'deep-linking-verified';
    l.deepLinkingResult = { at: new Date().toISOString(), contentItems: items, msg: claims[DL + 'msg'], log: claims[DL + 'log'], errormsg: claims[DL + 'errormsg'], errorlog: claims[DL + 'errorlog'] };
    save();
    return l.deepLinkingResult;
  }

  function adminSection() {
    const opt = (name, label, value = '', type = 'text') => `<label>${e(label)}<input name="${e(name)}" type="${e(type)}" value="${e(value)}"></label>`;
    const toolOptions = data.tools.map(t => `<option value="${e(t.id)}">${e(t.name)} (${e(t.clientId)})</option>`).join('');
    return `<section><h2>Platform mode: launch a tool from this harness</h2><p>The harness can act as the LTI 1.3 platform. Register a tool that supports LTI Advantage using these platform details, then register that tool below and start a launch.</p>${pretty(info())}</section>
    <section><h2>Register a tool</h2><form method="post" action="/admin/platform/tools"><label>Tool name<input name="name" required></label><label>OIDC login initiation URL<input name="loginUrl" type="url" required></label><label>Redirect URIs (comma separated)<input name="redirectUris" required></label>${opt('targetLinkUri', 'Target link URI (default: first redirect URI)')}${opt('deepLinkUrl', 'Deep Linking target URI (default: target link URI)')}${opt('jwksUrl', 'Tool public keyset URL (needed to verify Deep Linking responses)')}${opt('clientId', 'Client ID (generated when blank)')}${opt('deploymentId', 'Deployment ID', '1')}<label>Login initiation method<select name="loginMethod"><option>POST</option><option>GET</option></select></label><button>Register tool</button></form></section>
    <section><h2>Start a launch</h2>${data.tools.length ? `<form method="post" action="/admin/platform/launches"><label>Tool<select name="toolId">${toolOptions}</select></label><label>Message<select name="messageType">${PLATFORM_MESSAGES.map(m => `<option>${m}</option>`).join('')}</select></label>${opt('sub', 'User identifier (sub)', 'harness-user-1')}${opt('name', 'Name', 'Harness User')}${opt('given_name', 'Given name', 'Harness')}${opt('family_name', 'Family name', 'User')}${opt('email', 'Email', 'harness.user@example.invalid')}${opt('roles', 'Roles (comma separated; Learner, Instructor, Administrator or role URIs; blank for the message default)')}<button>Create launch</button></form>` : '<p>Register a tool first.</p>'}</section>
    <section><h2>Platform tools</h2>${pretty(data.tools)}</section>
    <section><h2>Platform launches</h2><ul>${[...data.platformLaunches].reverse().map(l => `<li><a href="/platform/launch/${e(l.id)}">${e(l.createdAt)} · ${e(l.messageType)} · ${e(l.status)}</a></li>`).join('') || '<li>No platform launches yet</li>'}</ul></section>`;
  }

  async function handle(req, res, url, path) {
    // Unauthenticated platform endpoints, reached by the user's browser and by the tool.
    if (req.method === 'GET' && path === '/platform.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end("document.getElementById('platform-autosubmit')?.submit();");
      return true;
    }
    if (req.method === 'GET' && path === '/platform/jwks.json') { json(res, 200, { keys: [publicJwk(data.privateKey, data.kid)] }); return true; }
    if (path === '/platform/token') { json(res, 501, { error: 'unsupported_grant_type', error_description: 'Platform services are not implemented by the harness' }); return true; }
    const start = path.match(/^\/platform\/launch\/([^/]+)$/);
    if (start && req.method === 'GET') {
      const l = data.platformLaunches.find(x => x.id === start[1]); insist(l, 'Launch not found', 404);
      insist(l.status === 'created' || l.status === 'initiated', 'Launch has already been used; create a new one');
      insist(l.expires > Date.now(), 'Launch expired; create a new one');
      const tool = data.tools.find(t => t.id === l.toolId); insist(tool, 'Tool removed', 404);
      l.status = 'initiated'; save();
      const params = { iss: base, login_hint: l.loginHint, target_link_uri: l.spec.targetLinkUri, lti_message_hint: l.id, client_id: tool.clientId, lti_deployment_id: tool.deploymentId };
      if (tool.loginMethod === 'GET') {
        const target = new URL(tool.loginUrl);
        for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
        res.writeHead(302, { Location: target.href }); res.end();
      } else page(res, 'Starting launch', `<section><p>Starting ${e(l.messageType)} for ${e(tool.name)}.</p>${autoForm(tool.loginUrl, params, 'Continue to the tool')}</section>`);
      return true;
    }
    if (path === '/platform/auth' && ['GET', 'POST'].includes(req.method)) {
      const input = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
      const tool = data.tools.find(t => t.clientId === input.client_id); insist(tool, 'Unknown client_id');
      insist(tool.redirectUris.includes(input.redirect_uri), 'redirect_uri is not registered for this tool');
      insist(input.scope === 'openid' && input.response_type === 'id_token' && input.response_mode === 'form_post' && input.prompt === 'none', 'Unsupported authentication request parameters');
      const state = text(input.state, 'state', 4000); const nonce = text(input.nonce, 'nonce', 4000);
      const l = data.platformLaunches.find(x => x.id === input.lti_message_hint); insist(l && l.toolId === tool.id, 'Unknown lti_message_hint');
      insist(input.login_hint === l.loginHint, 'login_hint does not match the launch');
      insist(l.status === 'initiated' && l.expires > Date.now(), 'Launch expired or already used');
      const claims = buildClaims(l, tool, nonce);
      l.status = 'token-issued'; l.issuedClaims = claims; l.authenticatedAt = new Date().toISOString(); save();
      const idToken = jwtSign(claims, l.spec.signature === 'invalid' ? wrongPrivateKey() : data.privateKey, data.kid);
      page(res, 'Returning to the tool', `<section><p>Authentication complete.</p>${autoForm(input.redirect_uri, { id_token: idToken, state }, 'Continue to the tool')}</section>`);
      return true;
    }
    const dlReturn = path.match(/^\/platform\/deeplink-return\/([^/]+)$/);
    if (dlReturn && req.method === 'POST') {
      const l = data.platformLaunches.find(x => x.id === dlReturn[1]); insist(l && l.messageType === 'LtiDeepLinkingRequest', 'Launch not found', 404);
      const tool = data.tools.find(t => t.id === l.toolId); insist(tool, 'Tool removed', 404);
      const result = await verifyDeepLinkReturn(l, tool, await body(req));
      page(res, 'Deep Linking return verified', `<section role="status"><p>The tool's response was verified and ${e(result.contentItems.length)} content item(s) were recorded.</p></section>${pretty(result)}`);
      return true;
    }
    const back = path.match(/^\/platform\/return\/([^/]+)$/);
    if (back && req.method === 'GET') {
      const l = data.platformLaunches.find(x => x.id === back[1]); insist(l, 'Launch not found', 404);
      const messages = {};
      for (const key of ['lti_msg', 'lti_log', 'lti_errormsg', 'lti_errorlog']) if (url.searchParams.has(key)) messages[key] = url.searchParams.get(key).slice(0, 1000);
      if (Object.keys(messages).length) { l.returnMessages = messages; save(); }
      page(res, 'Returned to platform', `<section role="status"><p>The tool returned to the platform.</p></section>${pretty(messages)}`);
      return true;
    }

    // Authenticated management routes.
    const managed = path === '/api/platform' || path.startsWith('/api/platform/') || path.startsWith('/admin/platform/');
    if (!managed) return false;
    authorize(req, res); if (req.method !== 'GET') checkOrigin(req);
    const admin = path.startsWith('/admin');
    const redirect = location => { res.writeHead(303, { Location: location }); res.end(); return true; };
    if (req.method === 'GET' && path === '/api/platform') { json(res, 200, info()); return true; }
    if (path === '/api/platform/tools' || path === '/admin/platform/tools') {
      if (req.method === 'GET' && !admin) { json(res, 200, data.tools); return true; }
      if (req.method === 'POST') {
        const tool = addTool(await body(req));
        return admin ? redirect('/admin') : (json(res, 201, tool), true);
      }
    }
    const toolPath = path.match(/^\/api\/platform\/tools\/([^/]+)$/);
    if (toolPath && req.method === 'DELETE') {
      const index = data.tools.findIndex(t => t.id === toolPath[1]); insist(index >= 0, 'Tool not found', 404);
      data.tools.splice(index, 1); data.platformLaunches = data.platformLaunches.filter(l => l.toolId !== toolPath[1]); save();
      json(res, 200, { deleted: true }); return true;
    }
    if (path === '/api/platform/launches' || path === '/admin/platform/launches') {
      if (req.method === 'GET' && !admin) { json(res, 200, data.platformLaunches.map(view)); return true; }
      if (req.method === 'DELETE' && !admin) { data.platformLaunches = []; save(); json(res, 200, { deleted: true }); return true; }
      if (req.method === 'POST') {
        const input = await body(req);
        if (admin) {
          const { sub, name, given_name, family_name, email, roles, ...rest } = input;
          const user = Object.fromEntries(Object.entries({ sub, name, given_name, family_name, email, roles }).filter(([, v]) => v));
          const l = addLaunch({ ...rest, user });
          page(res, 'Launch ready', `<section role="status"><p>Open the launch in a browser session for the intended user. It expires at ${e(new Date(l.expires).toISOString())} and can be used once.</p><p><a href="/platform/launch/${e(l.id)}" target="_blank" rel="noopener">Start ${e(l.messageType)}</a></p></section><p><a href="/admin">Back to administration</a></p>`);
          return true;
        }
        const l = addLaunch(input); json(res, 201, view(l)); return true;
      }
    }
    const launchPath = path.match(/^\/api\/platform\/launches\/([^/]+)$/);
    if (launchPath && req.method === 'GET') {
      const l = data.platformLaunches.find(x => x.id === launchPath[1]); insist(l, 'Launch not found', 404);
      json(res, 200, view(l)); return true;
    }
    insist(false, 'API route not found', 404);
  }

  return { handle, adminSection, info };
}
