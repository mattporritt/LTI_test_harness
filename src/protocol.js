import { createHmac, createHash, timingSafeEqual, createPrivateKey, createPublicKey, sign, verify, randomUUID } from 'node:crypto';

export const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
export const DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
export const AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/';
export const NRPS = 'https://purl.imsglobal.org/spec/lti-nrps/claim/';
export const SCOPE = {
  lineitem: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
  readonly: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
  score: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
  result: 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
  members: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
};
export function insist(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function equal(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function webURL(value) {
  const u = new URL(value);
  insist(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash, 'Expected an HTTP(S) URL without credentials or fragment');
  return u;
}
export function jwtSign(payload, privateKey, kid) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
export function jwtParts(token) {
  insist(typeof token === 'string' && token.length < 100000, 'Invalid JWT');
  const parts = token.split('.');
  insist(parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)), 'Malformed JWT');
  try { return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), parts }; }
  catch { throw Object.assign(new Error('Malformed JWT JSON'), { status: 400 }); }
}
export function jwtVerify(token, jwks, { issuer, audience, now = Math.floor(Date.now() / 1000) }) {
  const { header, claims, parts } = jwtParts(token);
  insist(header && typeof header === 'object' && !Array.isArray(header) && claims && typeof claims === 'object' && !Array.isArray(claims), 'JWT header and payload must be objects');
  insist(header.alg === 'RS256' && !header.crit, 'Only RS256 JWTs without critical extensions are supported');
  const keys = (jwks.keys || []).filter(k => k.kty === 'RSA' && k.kid === header.kid && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  insist(keys.length === 1, 'JWT signing key not found or ambiguous');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  insist(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')), 'Invalid JWT signature');
  insist(claims.iss === issuer, 'Issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  insist(aud.includes(audience), 'Audience mismatch');
  insist((aud.length < 2 && claims.azp === undefined) || claims.azp === audience, 'Authorized party mismatch');
  insist(Number.isFinite(claims.exp) && claims.exp > now, 'JWT expired or missing exp');
  insist(Number.isFinite(claims.iat) && claims.iat <= now + 60 && claims.iat >= now - 600 && claims.exp > claims.iat, 'Invalid JWT issued-at time');
  insist(claims.nbf === undefined || (Number.isFinite(claims.nbf) && claims.nbf <= now + 60), 'JWT not yet valid');
  return claims;
}
const enc = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauthSignature(method, url, pairs, secret, tokenSecret = '') {
  const u = webURL(url);
  const all = [...u.searchParams, ...pairs].filter(([k]) => k !== 'oauth_signature');
  all.sort(([ak, av], [bk, bv]) => enc(ak) < enc(bk) ? -1 : enc(ak) > enc(bk) ? 1 : enc(av) < enc(bv) ? -1 : enc(av) > enc(bv) ? 1 : 0);
  const normalized = all.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const baseURL = `${u.protocol}//${u.host}${u.pathname || '/'}`;
  return createHmac('sha1', `${enc(secret)}&${enc(tokenSecret)}`).update([method.toUpperCase(), baseURL, normalized].map(enc).join('&')).digest('base64');
}
export function oauthHeader(method, url, secret, key, body) {
  const p = new URLSearchParams({ oauth_consumer_key: key, oauth_nonce: randomUUID(), oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0', oauth_body_hash: createHash('sha1').update(body).digest('base64') });
  p.set('oauth_signature', oauthSignature(method, url, p, secret));
  return 'OAuth ' + [...p].map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}
export function publicJwk(privateKey, kid) {
  return { ...createPublicKey(createPrivateKey(privateKey)).export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}
export function formPost(url, fields) {
  webURL(url);
  return `<form method="post" action="${escapeHTML(url)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${escapeHTML(k)}" value="${escapeHTML(v)}">`).join('')}<button type="submit">Return to platform</button></form>`;
}
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
