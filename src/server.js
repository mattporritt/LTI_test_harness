import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { dynamicRegistration } from './registration.js';
import { scorePayload, ACTIVITY_PROGRESS, GRADING_PROGRESS } from './score.js';
import { LTI, DL, AGS, NRPS, SCOPE, insist, equal, webURL, jwtSign, jwtParts, jwtVerify, oauthSignature, oauthHeader, publicJwk, formPost, escapeHTML as e } from './protocol.js';

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
function page(res, title, content, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)} · LTI harness</title><style>
  :root{font-family:system-ui,sans-serif;color:#202b39;background:#f3f6f9}body{max-width:1000px;margin:36px auto;padding:0 24px}a{color:#125ca5}header{border-bottom:3px solid #237c83;margin-bottom:24px}h1{font-size:1.8rem}section,details{background:white;border:1px solid #cad4df;border-radius:8px;padding:20px;margin:16px 0}label{display:block;margin:12px 0}input,select,textarea,button{font:inherit;padding:9px;border:1px solid #8497ab;border-radius:4px}input:not([type=checkbox]),textarea{display:block;width:min(95%,700px)}textarea{min-height:100px}button{background:#125ca5;color:white;cursor:pointer}button:hover{background:#084376}:focus-visible{outline:3px solid #b24c00;outline-offset:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f6;padding:16px}code{overflow-wrap:anywhere}.muted{color:#4a596c}.error{border-left:5px solid #b62727}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #d3dce5}
  </style></head><body><header><p>LTI development tools</p><h1>${e(title)}</h1></header>${content}</body></html>`);
}
const field = (name, label, value = '', type = 'text') => `<label>${e(label)}<input name="${e(name)}" type="${e(type)}" value="${e(value)}"${type === 'number' ? ' step="any"' : ''} required></label>`;
const select = (name, label, values, selected) => `<label>${e(label)}<select name="${e(name)}">${values.map(value => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(value)}</option>`).join('')}</select></label>`;
const pretty = value => `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
async function body(req) {
  let text = ''; let length = 0;
  for await (const chunk of req) { length += chunk.length; insist(length <= 1024 * 1024, 'Request too large', 413); text += chunk; }
  if ((req.headers['content-type'] || '').startsWith('application/json')) {
    try { const data = JSON.parse(text); insist(data && typeof data === 'object' && !Array.isArray(data), 'Expected object'); return data; }
    catch { insist(false, 'Invalid JSON'); }
  }
  const params = new URLSearchParams(text);
  insist([...new Set(params.keys())].every(k => params.getAll(k).length === 1), 'Duplicate form parameter');
  return Object.fromEntries(params);
}
const now = () => Math.floor(Date.now() / 1000);

export function createHarness(options = {}) {
  const base = (options.baseUrl || process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
  insist(webURL(base).pathname === '/', 'PUBLIC_URL must be an origin without a path');
  const token = options.token || process.env.HARNESS_TOKEN;
  insist(typeof token === 'string' && token.length >= 16, 'Set HARNESS_TOKEN to at least 16 characters');
  const store = new Store(options.dataDir || process.env.DATA_DIR || './data', options.maxLaunches || 500);
  const d = store.data;
  const outbound = options.fetch || fetch;
  const launchURL = `${base}/lti/launch`;
  const allowNumericResourceLinkId = options.allowNumericResourceLinkId ?? process.env.ALLOW_NUMERIC_RESOURCE_LINK_ID === 'true';

  // Private Docker networks and local HTTP are deliberately allowed for test platforms.
  // Every outbound origin must first be trusted by an authenticated operator.
  async function request(url, init = {}, origins) {
    const u = webURL(url);
    insist(origins.includes(u.origin), 'Outbound URL origin is not registered');
    const result = await outbound(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const chunks = []; let size = 0;
    if (result.body) for await (const chunk of result.body) { size += chunk.length; insist(size <= 2 * 1024 * 1024, 'Upstream response too large', 502); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString();
    insist(result.status < 300 || result.status >= 400, `Upstream redirect refused (${result.status}); stored URLs must remain usable`, 502);
    return { status: result.status, headers: Object.fromEntries(result.headers), body: text };
  }
  async function requestJSON(url, init, origins) {
    const r = await request(url, init, origins);
    insist(r.status >= 200 && r.status < 300, `Upstream HTTP ${r.status}: ${r.body.slice(0, 500)}`, 502);
    try { return JSON.parse(r.body); } catch { insist(false, 'Upstream returned invalid JSON', 502); }
  }
  function authorize(req, res) {
    const auth = req.headers.authorization || '';
    const basic = Buffer.from(auth.startsWith('Basic ') ? auth.slice(6) : '', 'base64').toString();
    if (equal(auth, `Bearer ${token}`) || equal(basic, `admin:${token}`)) return;
    res.setHeader('WWW-Authenticate', 'Basic realm="LTI harness administration"');
    insist(false, 'Administrator authentication required', 401);
  }
  function checkOrigin(req) {
    // The API uses non-simple Authorization headers; browser forms use Basic auth.
    insist(!req.headers.origin || req.headers.origin === base, 'Cross-origin management request refused', 403);
    insist(!['cross-site'].includes(req.headers['sec-fetch-site']), 'Cross-site management request refused', 403);
  }
  function platformData(input, allowPendingDeployment = false) {
    for (const key of ['name', 'issuer', 'clientId', 'authUrl', 'tokenUrl', 'jwksUrl']) insist(typeof input[key] === 'string' && input[key].length, `Missing ${key}`);
    webURL(input.issuer);
    const deploymentIds = Array.isArray(input.deploymentIds) ? input.deploymentIds : String(input.deploymentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    insist((deploymentIds.length || allowPendingDeployment) && deploymentIds.every(s => typeof s === 'string' && s.length), 'At least one deployment ID is required');
    const extra = Array.isArray(input.serviceOrigins) ? input.serviceOrigins : String(input.serviceOrigins || '').split(',').map(s => s.trim()).filter(Boolean);
    const origins = [...new Set([input.issuer, input.authUrl, input.tokenUrl, input.jwksUrl, ...extra].map(s => webURL(s).origin))];
    insist(!d.platforms.some(p => p.issuer === input.issuer && p.clientId === input.clientId), 'Issuer/client already registered', 409);
    return { id: randomUUID(), name: input.name, issuer: input.issuer, clientId: input.clientId, authUrl: input.authUrl, tokenUrl: input.tokenUrl, jwksUrl: input.jwksUrl, deploymentIds, origins };
  }
  const dynamic = dynamicRegistration({ base, request, platformData, platforms: d.platforms, save: () => store.save() });
  function registration() {
    return { name: 'LTI test harness', dynamic_registration_links: `${base}/api/registration-links`, initiate_login_uri: `${base}/lti/login`, redirect_uris: [launchURL], jwks_uri: `${base}/.well-known/jwks.json`, target_link_uri: launchURL, deep_linking_uri: launchURL, messages: ['LtiResourceLinkRequest', 'LtiDeepLinkingRequest', 'LtiSubmissionReviewRequest'], api: `${base}/api`, supported: ['LTI 1.1 basic launch and Basic Outcomes', 'LTI 1.3', 'Deep Linking 2.0', 'AGS 2.0', 'NRPS 2.0', 'Submission Review 1.0'] };
  }
  function adminPage(res) {
    page(res, 'Tool administration', `<p>Register a platform, then copy these tool endpoints into its external-tool configuration. Use this service only with test accounts.</p><section><h2>Tool endpoints</h2>${pretty(registration())}</section>
    <section><h2>Dynamic registration</h2><p>Create a one-use link, paste it into Moodle’s Add LTI Advantage field, then confirm registration. Links expire after 10 minutes.</p><form method="post" action="/admin/registration-links">${field('origins','Trusted platform origins (comma separated)','','text')}${field('name','Tool name','LTI test harness')}<button>Create registration link</button></form></section>
    <section><h2>Register an LTI 1.3 platform</h2><form method="post" action="/admin/platforms">${field('name','Display name')}${field('issuer','Issuer (exact platform value)', '', 'url')}${field('clientId','Client ID')}${field('deploymentIds','Deployment IDs (comma separated)')}${field('authUrl','Authentication URL', '', 'url')}${field('tokenUrl','Access token URL', '', 'url')}${field('jwksUrl','Public keyset URL', '', 'url')}<label>Additional trusted service origins (comma separated)<input name="serviceOrigins" placeholder="https://services.example.org"></label><button>Register platform</button></form></section>
    <section><h2>Register an LTI 1.1 consumer</h2><form method="post" action="/admin/consumers">${field('name','Consumer display name')}${field('key','Consumer key')}${field('secret','Shared secret', '', 'password')}<label>Trusted outcome service origins (comma separated)<input name="serviceOrigins" placeholder="https://lms.example.org"></label><button>Register consumer</button></form></section>
    <section><h2>Registrations</h2>${pretty(d.platforms)}${d.platforms.filter(p => !p.deploymentIds.length).map(p => `<form method="post" action="/admin/platforms/${e(p.id)}/deployments"><p>Deployment required for ${e(p.name)} (${e(p.clientId)})</p>${field('deploymentIds','Deployment IDs (comma separated)')}<button>Save deployment IDs</button></form>`).join('')}${pretty(d.consumers.map(({ secret, ...p }) => p))}</section>
    <section><h2>Recorded launches</h2><ul>${[...d.launches].reverse().map(l => `<li><a href="/session/${e(l.id)}">${e(l.createdAt)} · ${e(l.version)} · ${e(l.messageType)}</a></li>`).join('') || '<li>No launches yet</li>'}</ul></section>`);
  }
  function sessionPage(res, l, result = '') {
    const actionForm = (action, fields, label) => `<form method="post" action="/session/${e(l.id)}/actions"><input type="hidden" name="action" value="${e(action)}">${fields}<button>${e(label)}</button></form>`;
    let controls = '';
    if (l.messageType === 'LtiDeepLinkingRequest') controls += `<section><h2>Select test content</h2>${actionForm('deep-link', '<label>Content<select name="content"><option value="echo">Claims explorer</option><option value="quiz">One-question quiz</option></select></label><label>Title<input name="title" value="Harness activity" required></label>', 'Select content and prepare return')}</section>`;
    else if (l.messageType === 'LtiSubmissionReviewRequest') {
      const user = l.claims[LTI + 'for_user'].user_id;
      const resource = l.claims[LTI + 'resource_link']?.id;
      const submissions = d.launches.filter(other => other.platformId === l.platformId && other.claims[LTI + 'deployment_id'] === l.claims[LTI + 'deployment_id'] && other.claims.sub === user && other.messageType === 'LtiResourceLinkRequest' && (resource ? other.claims[LTI + 'resource_link']?.id === resource : other.claims[AGS + 'endpoint']?.lineitem === l.claims[AGS + 'endpoint'].lineitem)).flatMap(other => other.actions.filter(a => a.action === 'answer').map(a => ({ launch: other.id, ...a })));
      controls += `<section><h2>Submission review</h2><p>Reviewing learner ${e(user)}. Reviewer: ${e(l.claims.sub)}.</p>${submissions.length ? pretty(submissions) : '<p>No locally recorded submissions for this learner and resource.</p>'}<p>This view is read-only.</p></section>`;
    } else {
      const content = l.claims[LTI + 'custom']?.harness_content || l.claims.custom_harness_content || 'quiz';
      if (content === 'echo') controls += '<section><h2>Claims explorer</h2><p>This resource displays verified platform claims below.</p></section>';
      else controls += `<section><h2>Interactive test content</h2><p>What is 2 + 2?</p>${actionForm('answer', '<label>Your answer<input type="number" name="answer" required></label>', 'Check answer')}<p>Checking the answer records a local result. Send a score separately below.</p></section>`;
      if (l.version === '1.3') controls += `<section><h2>Platform services</h2>${actionForm('lineitems', '', 'Read line items')}${actionForm('create-lineitem', field('label', 'New line item label', 'Harness grade'), 'Create line item')}${actionForm('members', '', 'Read roster')}${actionForm('results', '', 'Read results')}${actionForm('score', field('scoreGiven', 'Score value (ignored for null/omit)', '80', 'number') + field('scoreMaximum', 'Score maximum', '100', 'number') + select('scoreMode', 'Score mode (null/omit clear the grade)', ['value', 'null', 'omit'], 'value') + select('activityProgress', 'Activity progress', ACTIVITY_PROGRESS, 'Completed') + select('gradingProgress', 'Grading progress', GRADING_PROGRESS, 'FullyGraded') + `<label>Line item URL (optional override)<input name="lineitemUrl" value="${e(l.lineitemUrl || l.claims[AGS + 'endpoint']?.lineitem || '')}"></label>` + '<label>Timestamp (optional ISO 8601, for stale-update tests)<input name="timestamp" placeholder="2026-10-28T00:00:00.000Z"></label>', 'Send score for launched user')}<p>Services require the relevant platform permissions. The exact advertised URL is used; redirects fail the request.</p></section>`;
      if (l.version === '1.1') controls += `<section><h2>Basic Outcomes</h2>${actionForm('outcome', field('scoreGiven','Score (0–100)', '80', 'number'), 'Send outcome grade')}</section>`;
    }
    page(res, 'Launch inspector', `<p>Protocol ${e(l.version)} · ${e(l.messageType)}</p>${l.warnings?.length ? `<section role="alert"><h2>Protocol warnings</h2>${pretty(l.warnings)}</section>` : ''}${result ? `<section role="status"><h2>Action result</h2>${result}</section>` : ''}${controls}<details open><summary>Verified launch claims</summary>${pretty(l.claims)}</details><details><summary>Action history</summary>${pretty(l.actions)}</details><p class="muted">Session links grant access to this test launch. They expire when records are deleted or evicted by retention limits.</p>`);
  }
  async function accessToken(p, scopes) {
    const assertion = jwtSign({ iss: p.clientId, sub: p.clientId, aud: p.tokenUrl, iat: now(), exp: now() + 60, jti: randomUUID() }, d.privateKey, d.kid);
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, scope: scopes.join(' ') });
    const r = await requestJSON(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, p.origins);
    insist(typeof r.access_token === 'string' && r.token_type?.toLowerCase() === 'bearer', 'Invalid platform token response', 502);
    if (r.scope) insist(scopes.every(s => r.scope.split(' ').includes(s)), 'Platform did not grant requested scope', 403);
    return r.access_token;
  }
  async function action(l, input) {
    const action = input.action;
    insist(l.messageType !== 'LtiSubmissionReviewRequest' || ['members', 'lineitems', 'results'].includes(action), 'Submission review is read-only in this harness', 403);
    if (action === 'answer') {
      insist(l.messageType !== 'LtiDeepLinkingRequest', 'Choose content before answering');
      insist(input.answer !== undefined && String(input.answer).trim() !== '', 'Answer required');
      const result = { correct: Number(input.answer) === 4, score: Number(input.answer) === 4 ? 100 : 0 };
      l.actions.push({ action, at: new Date().toISOString(), result }); store.save(); return result;
    }
    if (action === 'deep-link') {
      insist(l.version === '1.3' && l.messageType === 'LtiDeepLinkingRequest', 'Not a Deep Linking launch');
      const p = d.platforms.find(p => p.id === l.platformId);
      insist(p, 'Platform was removed');
      const settings = l.claims[DL + 'deep_linking_settings'];
      insist(settings?.accept_types?.includes('ltiResourceLink'), 'Platform does not accept ltiResourceLink');
      insist(['echo', 'quiz'].includes(input.content || 'echo'), 'Unknown content');
      const claims = { iss: p.clientId, aud: p.issuer, iat: now(), exp: now() + 300, nonce: randomUUID(), [LTI + 'deployment_id']: l.claims[LTI + 'deployment_id'], [LTI + 'message_type']: 'LtiDeepLinkingResponse', [LTI + 'version']: '1.3.0', [DL + 'content_items']: [{ type: 'ltiResourceLink', title: String(input.title || 'Harness activity').slice(0, 200), url: launchURL, custom: { harness_content: input.content || 'echo' }, lineItem: { scoreMaximum: 100, label: 'Harness grade', resourceId: 'harness-quiz', tag: 'harness', submissionReview: { url: launchURL, label: 'Review harness submission' } } }] };
      if (settings.accept_lineitem === false) delete claims[DL + 'content_items'][0].lineItem;
      if (settings.data !== undefined) claims[DL + 'data'] = settings.data;
      const target = webURL(settings.deep_link_return_url);
      insist(p.origins.includes(target.origin), 'Deep Linking return origin is not registered');
      const result = { url: settings.deep_link_return_url, JWT: jwtSign(claims, d.privateKey, d.kid), claims };
      l.actions.push({ action, at: new Date().toISOString(), result: { claims, url: result.url } }); store.save(); return result;
    }
    if (action === 'outcome') {
      insist(l.version === '1.1', 'Basic Outcomes requires LTI 1.1');
      const consumer = d.consumers.find(c => c.id === l.consumerId);
      insist(consumer, 'Consumer was removed');
      const score = Number(input.scoreGiven);
      insist(input.scoreGiven !== undefined && String(input.scoreGiven).trim() && Number.isFinite(score) && score >= 0 && score <= 100, 'Score must be between 0 and 100');
      const url = l.claims.lis_outcome_service_url;
      insist(url && l.claims.lis_result_sourcedid, 'Launch has no outcome service');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0"><imsx_POXHeader><imsx_POXRequestHeaderInfo><imsx_version>V1.0</imsx_version><imsx_messageIdentifier>${randomUUID()}</imsx_messageIdentifier></imsx_POXRequestHeaderInfo></imsx_POXHeader><imsx_POXBody><replaceResultRequest><resultRecord><sourcedGUID><sourcedId>${e(l.claims.lis_result_sourcedid)}</sourcedId></sourcedGUID><result><resultScore><language>en</language><textString>${score / 100}</textString></resultScore></result></resultRecord></replaceResultRequest></imsx_POXBody></imsx_POXEnvelopeRequest>`;
      const r = await request(url, { method: 'POST', headers: { Authorization: oauthHeader('POST', url, consumer.secret, consumer.key, xml), 'Content-Type': 'application/xml' }, body: xml }, consumer.origins);
      const result = { ...r, success: r.status >= 200 && r.status < 300 && /<(?:\w+:)?imsx_codeMajor\b[^>]*>\s*success\s*<\//.test(r.body) };
      l.actions.push({ action, url, at: new Date().toISOString(), result }); store.save(); return result;
    }
    insist(l.version === '1.3', 'This action requires LTI 1.3');
    const p = d.platforms.find(p => p.id === l.platformId);
    insist(p, 'Platform was removed');
    const ags = l.claims[AGS + 'endpoint'] || {};
    const nrps = l.claims[NRPS + 'namesroleservice'] || {};
    let url, scope, method = 'GET', contentType, payload;
    if (action === 'members') { url = nrps.context_memberships_url; scope = SCOPE.members; contentType = 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json'; }
    else if (action === 'lineitems') { url = ags.lineitems; scope = ags.scope?.includes(SCOPE.readonly) ? SCOPE.readonly : SCOPE.lineitem; contentType = 'application/vnd.ims.lis.v2.lineitemcontainer+json'; }
    else if (action === 'create-lineitem') {
      url = ags.lineitems; scope = SCOPE.lineitem; method = 'POST'; contentType = 'application/vnd.ims.lis.v2.lineitem+json';
      payload = { scoreMaximum: 100, label: String(input.label || 'Harness grade').slice(0, 200), resourceId: 'harness-quiz', tag: 'harness', submissionReview: { url: launchURL, label: 'Review harness submission' } };
      if (Object.hasOwn(input, 'resourceLinkId')) {
        insist(input.resourceLinkId === null || (typeof input.resourceLinkId === 'string' && input.resourceLinkId.length > 0), 'resourceLinkId must be a non-empty string or null');
        if (input.resourceLinkId !== null) payload.resourceLinkId = input.resourceLinkId;
      } else if (l.claims[LTI + 'resource_link']?.id) payload.resourceLinkId = l.claims[LTI + 'resource_link'].id;
    } else if (['score', 'results'].includes(action)) {
      // Use the stored/advertised URL verbatim, preserving legacy paths and query strings.
      const lineitem = input.lineitemUrl || l.lineitemUrl || ags.lineitem;
      insist(lineitem, 'No line item URL; create one or supply lineitemUrl');
      if (action === 'score') {
        scope = SCOPE.score; method = 'POST'; contentType = 'application/vnd.ims.lis.v1.score+json';
        payload = scorePayload(input, l.claims.sub);
      } else { scope = SCOPE.result; contentType = 'application/vnd.ims.lis.v2.resultcontainer+json'; }
      const u = webURL(lineitem); u.pathname = u.pathname.replace(/\/$/, '') + (action === 'score' ? '/scores' : '/results'); url = u.href;
    } else insist(false, 'Unknown action');
    insist(url, 'Service was not advertised in this launch');
    if (action !== 'members') insist(Array.isArray(ags.scope) && ags.scope.includes(scope), 'Required AGS scope not advertised', 403);
    insist(p.origins.includes(webURL(url).origin), 'Service origin is not registered');
    if (input.pageUrl) {
      insist(['members', 'lineitems', 'results'].includes(action), 'pageUrl is only supported for read actions');
      insist(p.origins.includes(webURL(input.pageUrl).origin), 'Page origin is not registered');
      url = input.pageUrl;
    }
    const access = await accessToken(p, [scope]);
    const r = await request(url, { method, headers: { Authorization: `Bearer ${access}`, Accept: contentType, ...(payload ? { 'Content-Type': contentType } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, p.origins);
    let response; try { response = JSON.parse(r.body); } catch { response = r.body; }
    if (action === 'create-lineitem' && r.status >= 200 && r.status < 300 && response?.id) {
      insist(p.origins.includes(webURL(response.id).origin), 'Returned line item origin is not registered'); l.lineitemUrl = response.id;
    }
    const result = { request: { method, url, scope, body: payload }, response: { status: r.status, headers: r.headers, body: response }, success: r.status >= 200 && r.status < 300 };
    l.actions.push({ action, at: new Date().toISOString(), result }); store.save(); return result;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action http: https:; frame-ancestors http: https:; base-uri 'none'");
    try {
      const url = new URL(req.url, base); const path = url.pathname;
      if (req.method === 'GET' && path === '/registration-close.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end("document.getElementById('registration-close')?.addEventListener('click', () => { (window.opener || window.parent).postMessage({subject:'org.imsglobal.lti.close'}, '*'); });");
      }
      const registrationPath = path.match(/^\/lti\/register\/([^/]+)$/);
      if (registrationPath) {
        const id = registrationPath[1];
        if (req.method === 'GET') {
          const info = dynamic.initiate(id, url.searchParams);
          return page(res, 'Confirm dynamic registration', `<section><p>Register <strong>${e(info.name)}</strong> with ${e(info.discovery)}?</p><p>Approved origins: ${e(info.origins.join(', '))}. This creates a client in the selected test LMS and saves its platform details here. Activate it separately in Moodle.</p><details><summary>Requested tool configuration</summary>${pretty(info.metadata)}</details><form method="post" action="/lti/register/${e(id)}"><button>Register tool</button></form></section>`);
        }
        if (req.method === 'POST') {
          checkOrigin(req);
          const result = await dynamic.complete(id);
          return page(res, 'Dynamic registration complete', `<section role="status"><p>Client ${e(result.platform.clientId)} saved. ${result.platform.deploymentIds.length ? 'Deployment saved.' : 'Deployment ID not supplied: add it through harness administration before launching.'} Review and activate the tool in Moodle.</p><button id="registration-close">Return to platform</button><script src="/registration-close.js"></script></section>${pretty(result.platform)}`);
        }
      }
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', version: '0.1.0' });
      if (req.method === 'GET' && path === '/.well-known/jwks.json') return json(res, 200, { keys: [publicJwk(d.privateKey, d.kid)] });
      if (req.method === 'GET' && path === '/registration') return json(res, 200, registration());
      if (req.method === 'GET' && path === '/') return page(res, 'LTI test harness', '<p>A standalone tool for verifying LTI launches, content selection, rosters and grade passback.</p><section><h2>Get started</h2><p><a href="/admin">Configure platforms and inspect launches</a> (user: admin, password: HARNESS_TOKEN)</p><p><a href="/registration">Tool registration endpoints (JSON)</a></p></section><p>Supports LTI 1.1 and 1.3. Intended for isolated development and testing with synthetic users.</p>');
      if (path.startsWith('/api') || path.startsWith('/admin')) {
        authorize(req, res); if (req.method !== 'GET') checkOrigin(req);
        if (req.method === 'GET' && path === '/admin') return adminPage(res);
        if (req.method === 'POST' && ['/api/registration-links', '/admin/registration-links'].includes(path)) {
          const input = await body(req);
          if (typeof input.origins === 'string') input.origins = input.origins.split(',').map(s => s.trim()).filter(Boolean);
          const link = dynamic.issue(input);
          if (path.startsWith('/api')) return json(res, 201, link);
          return page(res, 'Registration link ready', `<section role="status"><p>Copy this URL into Moodle’s Tool URL field and click Add LTI Advantage. It expires at ${e(link.expiresAt)} and can be used once.</p><p><code>${e(link.url)}</code></p><a href="/admin">Back to administration</a></section>`);
        }
        const deploymentPath = path.match(/^\/(api|admin)\/platforms\/([^/]+)\/deployments$/);
        if (req.method === 'POST' && deploymentPath) {
          const p = d.platforms.find(p => p.id === deploymentPath[2]); insist(p, 'Platform not found', 404);
          const input = await body(req);
          const ids = Array.isArray(input.deploymentIds) ? input.deploymentIds : String(input.deploymentIds || '').split(',').map(s => s.trim()).filter(Boolean);
          insist(ids.length > 0 && ids.every(id => typeof id === 'string' && id.length > 0), 'At least one deployment ID is required');
          p.deploymentIds = [...new Set(ids)];
          if (p.dynamicRegistration) p.dynamicRegistration.deploymentPending = false;
          store.save();
          if (deploymentPath[1] === 'api') return json(res, 200, p);
          res.writeHead(303, { Location: '/admin' }); return res.end();
        }
        if (req.method === 'GET' && path === '/api/platforms') return json(res, 200, d.platforms);
        if (req.method === 'GET' && path === '/api/consumers') return json(res, 200, d.consumers.map(({ secret, ...c }) => c));
        if (req.method === 'GET' && path === '/api/launches') return json(res, 200, d.launches);
        if (req.method === 'POST' && ['/api/platforms', '/admin/platforms'].includes(path)) {
          const p = platformData(await body(req)); d.platforms.push(p); store.save();
          if (path.startsWith('/api')) return json(res, 201, p);
          res.writeHead(303, { Location: '/admin' }); return res.end();
        }
        if (req.method === 'POST' && ['/api/consumers', '/admin/consumers'].includes(path)) {
          const input = await body(req);
          for (const key of ['name', 'key', 'secret']) insist(typeof input[key] === 'string' && input[key].length, `Missing ${key}`);
          insist(!d.consumers.some(c => c.key === input.key), 'Consumer key already registered', 409);
          const origins = (Array.isArray(input.serviceOrigins) ? input.serviceOrigins : String(input.serviceOrigins || '').split(',').filter(Boolean)).map(s => webURL(s.trim()).origin);
          const consumer = { id: randomUUID(), name: input.name, key: input.key, secret: input.secret, origins };
          d.consumers.push(consumer); store.save();
          if (path.startsWith('/api')) return json(res, 201, { ...consumer, secret: '[redacted]' });
          res.writeHead(303, { Location: '/admin' }); return res.end();
        }
        if (path === '/api/launches' && req.method === 'DELETE') { d.launches = []; store.save(); return json(res, 200, { deleted: true }); }
        const match = path.match(/^\/api\/launches\/([^/]+)(\/actions)?$/);
        if (match) {
          const l = d.launches.find(l => l.id === match[1]); insist(l, 'Launch not found', 404);
          if (req.method === 'GET' && !match[2]) return json(res, 200, l);
          if (req.method === 'POST' && match[2]) return json(res, 200, await action(l, await body(req)));
        }
        insist(false, 'API route not found', 404);
      }
      if (path === '/lti/login' && ['GET', 'POST'].includes(req.method)) {
        const input = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
        const candidates = d.platforms.filter(p => p.issuer === input.iss && (!input.client_id || p.clientId === input.client_id));
        insist(candidates.length === 1, 'Unknown or ambiguous issuer/client; register the platform first');
        const p = candidates[0]; insist(typeof input.login_hint === 'string' && input.login_hint.length, 'Missing login_hint');
        const target = input.target_link_uri || launchURL;
        insist(target === launchURL, 'Unregistered target_link_uri');
        const state = randomUUID(); const nonce = randomUUID();
        store.save(); // Expire abandoned logins before applying the pending-request cap.
        insist(Object.keys(d.pending).length < 2000, 'Too many pending logins', 429);
        d.pending[state] = { nonce, platformId: p.id, target, expires: Date.now() + 5 * 60 * 1000 }; store.save();
        const auth = new URL(p.authUrl);
        const params = { scope: 'openid', response_type: 'id_token', response_mode: 'form_post', prompt: 'none', client_id: p.clientId, redirect_uri: launchURL, login_hint: input.login_hint, state, nonce };
        if (input.lti_message_hint) params.lti_message_hint = input.lti_message_hint;
        for (const [key, value] of Object.entries(params)) auth.searchParams.set(key, value);
        res.writeHead(302, { Location: auth.href }); return res.end();
      }
      if (path === '/lti/launch' && req.method === 'POST') {
        const input = await body(req); let l;
        if (input.id_token || input.state || input.error) {
          const pending = d.pending[input.state];
          insist(pending && pending.expires > Date.now(), 'Unknown, expired or replayed state');
          // Consume before the first await: concurrent duplicate callbacks cannot both validate.
          delete d.pending[input.state]; store.save();
          insist(!input.error, `Platform refused authentication: ${String(input.error).slice(0, 200)}`);
          const p = d.platforms.find(p => p.id === pending.platformId); insist(p, 'Platform removed');
          const jwks = await requestJSON(p.jwksUrl, {}, p.origins);
          const claims = jwtVerify(input.id_token, jwks, { issuer: p.issuer, audience: p.clientId });
          insist(claims.nonce === pending.nonce, 'Nonce mismatch');
          insist(!d.replays[`${p.id}:${claims.nonce}`], 'Replayed nonce');
          insist(p.deploymentIds.includes(claims[LTI + 'deployment_id']), 'Deployment mismatch');
          insist(claims[LTI + 'version'] === '1.3.0', 'Invalid LTI version');
          insist(claims[LTI + 'target_link_uri'] === pending.target, 'Target link mismatch');
          insist(claims.sub === undefined || (typeof claims.sub === 'string' && claims.sub.length > 0), 'Invalid subject');
          insist(Array.isArray(claims[LTI + 'roles']) && claims[LTI + 'roles'].every(role => typeof role === 'string'), 'Missing or invalid roles');
          const messageType = claims[LTI + 'message_type'];
          insist(['LtiResourceLinkRequest', 'LtiDeepLinkingRequest', 'LtiSubmissionReviewRequest'].includes(messageType), 'Unsupported message type');
          const warnings = [];
          if (messageType === 'LtiResourceLinkRequest') {
            const resourceId = claims[LTI + 'resource_link']?.id;
            if (allowNumericResourceLinkId && Number.isSafeInteger(resourceId)) warnings.push('Platform sent a numeric resource_link.id; LTI 1.3 requires a string. Compatibility option enabled; raw claim preserved.');
            else insist(typeof resourceId === 'string' && resourceId.length, 'resource_link.id must be a non-empty string');
          }
          if (messageType === 'LtiSubmissionReviewRequest') { insist(typeof claims[LTI + 'for_user']?.user_id === 'string' && claims[LTI + 'for_user'].user_id.length && claims[AGS + 'endpoint']?.lineitem, 'Missing submission review user or line item'); webURL(claims[AGS + 'endpoint'].lineitem); }
          if (messageType === 'LtiDeepLinkingRequest') { const settings = claims[DL + 'deep_linking_settings']; insist(settings && Array.isArray(settings.accept_types) && settings.deep_link_return_url, 'Missing Deep Linking settings'); webURL(settings.deep_link_return_url); }
          d.replays[`${p.id}:${claims.nonce}`] = Date.now() + 10 * 60 * 1000;
          l = store.addLaunch({ version: '1.3', platformId: p.id, messageType, claims, warnings });
        } else {
          insist(!(req.headers['content-type'] || '').startsWith('application/json'), 'LTI 1.1 requires form encoding');
          const consumer = d.consumers.find(c => c.key === input.oauth_consumer_key); insist(consumer, 'Unknown consumer');
          insist(input.lti_message_type === 'basic-lti-launch-request' && input.lti_version === 'LTI-1p0', 'Unsupported LTI 1.1 message');
          insist(input.resource_link_id && input.oauth_nonce && input.oauth_signature_method === 'HMAC-SHA1' && (!input.oauth_version || input.oauth_version === '1.0'), 'Missing launch fields or unsupported signature');
          insist(/^\d+$/.test(input.oauth_timestamp || '') && Math.abs(now() - Number(input.oauth_timestamp)) <= 300, 'OAuth timestamp outside allowed window');
          const replay = `oauth:${consumer.id}:${input.oauth_nonce}`;
          insist(!d.replays[replay], 'Replayed OAuth nonce');
          insist(equal(input.oauth_signature, oauthSignature('POST', base + req.url, Object.entries(input), consumer.secret)), 'Invalid OAuth signature');
          d.replays[replay] = Date.now() + 10 * 60 * 1000;
          const { oauth_signature, ...claims } = input;
          l = store.addLaunch({ version: '1.1', consumerId: consumer.id, messageType: input.lti_message_type, claims });
        }
        res.writeHead(303, { Location: `/session/${l.id}` }); return res.end();
      }
      const session = path.match(/^\/session\/([^/]+)(\/actions)?$/);
      if (session) {
        const l = d.launches.find(l => l.id === session[1]); insist(l, 'Launch not found', 404);
        if (req.method === 'GET' && !session[2]) return sessionPage(res, l);
        if (req.method === 'POST' && session[2]) {
          checkOrigin(req); const result = await action(l, await body(req));
          return sessionPage(res, l, result.JWT ? formPost(result.url, { JWT: result.JWT }) + pretty(result.claims) : pretty(result));
        }
      }
      insist(false, 'Not found', 404);
    } catch (err) {
      const status = err.status || (err.code === 'ERR_INVALID_URL' || err instanceof SyntaxError ? 400 : 500);
      const message = status === 500 ? 'Internal harness error' : err.message;
      if (status === 500) console.error(err);
      if ((req.headers.accept || '').includes('application/json') || req.url.startsWith('/api')) return json(res, status, { error: message });
      const closeRegistration = req.url.startsWith('/lti/register/') ? '<button id="registration-close">Return to platform</button><script src="/registration-close.js"></script>' : '';
      page(res, 'Request failed', `<section class="error" role="alert"><p>${e(message)}</p>${closeRegistration}<p><a href="/">Harness home</a></p></section>`, status);
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, store, baseUrl: base };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createHarness();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log(`LTI harness listening on port ${process.env.PORT || 8080}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
