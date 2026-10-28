import { randomUUID } from 'node:crypto';
import { insist, webURL, SCOPE } from './protocol.js';

export const TOOL_CONFIG = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
export const PLATFORM_CONFIG = 'https://purl.imsglobal.org/spec/lti-platform-configuration';

export function clientMetadata(base, name = 'LTI test harness') {
  const launch = `${base}/lti/launch`;
  return {
    application_type: 'web', response_types: ['id_token'], grant_types: ['implicit', 'client_credentials'],
    client_name: name, client_uri: base, initiate_login_uri: `${base}/lti/login`,
    redirect_uris: [launch], jwks_uri: `${base}/.well-known/jwks.json`,
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'RS256',
    scope: Object.values(SCOPE).join(' '),
    [TOOL_CONFIG]: {
      domain: new URL(base).host, target_link_uri: launch,
      description: 'LTI development and regression testing with synthetic users.',
      claims: ['sub', 'name', 'given_name', 'family_name', 'email'],
      messages: [
        { type: 'LtiDeepLinkingRequest', target_link_uri: launch, label: 'Select harness content', placements: ['ContentArea'], supported_types: ['ltiResourceLink'] },
        { type: 'LtiSubmissionReviewRequest', target_link_uri: launch, label: 'Review harness submission' },
      ],
    },
  };
}

// Registration initiation is a capability issued by an authenticated operator.
// Keep platform-supplied tokens in bounded, expiring memory, never in captured data.
export function dynamicRegistration({ base, request, platformData, platforms, save, clock = Date.now }) {
  const tickets = new Map();
  function pending(id) {
    const p = tickets.get(id);
    if (p && p.expires <= clock()) tickets.delete(id);
    insist(p && p.expires > clock(), 'Registration link expired, already used or unknown', 410);
    return p;
  }
  function issue(input) {
    for (const [id, p] of tickets) if (p.expires <= clock()) tickets.delete(id);
    insist(tickets.size < 100, 'Too many pending registrations', 429);
    insist(Array.isArray(input.origins) && input.origins.length > 0 && input.origins.length <= 20, 'Supply trusted platform origins');
    const origins = [...new Set(input.origins.map(value => {
      const u = webURL(value);
      insist(u.pathname === '/' && !u.search, 'Trusted registration origins must not contain paths or queries');
      return u.origin;
    }))];
    const name = input.name || 'LTI test harness';
    insist(typeof name === 'string' && name.length <= 200, 'Invalid tool name');
    const id = randomUUID(); const expires = clock() + 10 * 60 * 1000;
    tickets.set(id, { origins, name, expires });
    return { url: `${base}/lti/register/${id}`, expiresAt: new Date(expires).toISOString() };
  }
  function initiate(id, params) {
    const p = pending(id);
    insist(params.getAll('openid_configuration').length === 1 && params.getAll('registration_token').length <= 1, 'Missing or duplicate registration parameters');
    const discovery = params.get('openid_configuration'); const u = webURL(discovery);
    insist(p.origins.includes(u.origin), 'Discovery origin was not approved');
    const token = params.get('registration_token') ?? '';
    insist(token.length <= 16000 && !/[\r\n]/.test(token), 'Invalid registration token');
    if (p.discovery) insist(p.discovery === discovery && p.token === token, 'Registration link already bound to another initiation');
    p.discovery = discovery; p.token = token;
    return { name: p.name, discovery, origins: p.origins, metadata: clientMetadata(base, p.name) };
  }
  async function complete(id) {
    const p = pending(id);
    insist(p.discovery, 'Platform has not initiated registration');
    tickets.delete(id); // Consume before awaiting: parallel submissions cannot register twice.
    async function json(url, init = {}) {
      const r = await request(url, init, p.origins);
      insist(r.status >= 200 && r.status < 300, `Dynamic registration upstream HTTP ${r.status}`, 502);
      let value;
      try { value = JSON.parse(r.body); } catch { insist(false, 'Dynamic registration returned invalid JSON', 502); }
      insist(value && typeof value === 'object' && !Array.isArray(value), 'Invalid registration document', 502);
      return value;
    }
    const config = await json(p.discovery);
    const issuer = webURL(config.issuer); const discovery = webURL(p.discovery);
    const prefix = issuer.pathname.replace(/\/$/, '');
    insist(!issuer.search && discovery.origin === issuer.origin && discovery.pathname.startsWith(prefix + '/'), 'Discovery URL must be below the exact platform issuer');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint']) {
      insist(typeof config[key] === 'string' && p.origins.includes(webURL(config[key]).origin), `Unapproved or missing ${key}`);
    }
    for (const [key, required] of [['response_types_supported', 'id_token'], ['id_token_signing_alg_values_supported', 'RS256'], ['token_endpoint_auth_methods_supported', 'private_key_jwt']]) {
      insist(Array.isArray(config[key]) && config[key].includes(required), `Platform does not support ${required}`);
    }
    insist(config[PLATFORM_CONFIG] && typeof config[PLATFORM_CONFIG].product_family_code === 'string', 'Missing LTI platform configuration');
    const requested = clientMetadata(base, p.name);
    const response = await json(config.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(p.token ? { Authorization: `Bearer ${p.token}` } : {}) },
      body: JSON.stringify(requested),
    });
    insist(typeof response.client_id === 'string' && response.client_id.length > 0, 'Registration response missing client_id', 502);
    const deployment = response[TOOL_CONFIG]?.deployment_id;
    insist(deployment === undefined || (typeof deployment === 'string' && deployment.length > 0), 'Invalid deployment_id in registration response', 502);
    const platform = platformData({
      name: p.name, issuer: config.issuer, clientId: response.client_id, deploymentIds: deployment ? [deployment] : [],
      authUrl: config.authorization_endpoint, tokenUrl: config.token_endpoint, jwksUrl: config.jwks_uri, serviceOrigins: p.origins,
    }, true);
    platform.dynamicRegistration = { grantedScopes: typeof response.scope === 'string' ? response.scope : '', deploymentPending: !deployment };
    platforms.push(platform); save();
    return { platform, requested };
  }
  return { issue, initiate, complete };
}
