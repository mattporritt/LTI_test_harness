// Real-platform service smoke. Run only against an explicitly selected test launch.
import assert from 'node:assert/strict';
const base = process.env.HARNESS_URL;
const token = process.env.HARNESS_TOKEN;
const id = process.env.LAUNCH_ID;
assert.ok(base && token && id, 'Set HARNESS_URL, HARNESS_TOKEN, LAUNCH_ID for a synthetic learner launch');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const response = await fetch(`${base}/api/launches/${id}`, { headers });
assert.equal(response.status, 200);
const launch = await response.json();
assert.equal(launch.version, '1.3');
assert.equal(launch.messageType, 'LtiResourceLinkRequest');
assert.ok(launch.claims.sub, 'Choose a non-anonymous learner launch');
const lineitem = launch.claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint']?.lineitem;
const summary = [];
async function action(data, expectSuccess = true, launchId = id) {
  const r = await fetch(`${base}/api/launches/${launchId}/actions`, { method: 'POST', headers, body: JSON.stringify(data) });
  const result = await r.json();
  summary.push({ action: data.action, apiStatus: r.status, serviceStatus: result.response?.status ?? result.status,
    success: result.success, url: result.request?.url, error: result.error });
  assert.equal(r.status, 200, JSON.stringify(result));
  assert.equal(result.success, expectSuccess, JSON.stringify(result));
  return result;
}
await action({ action: 'lineitems' });
const members = await action({ action: 'members' });
assert.ok(members.response.body.members.some(m => m.user_id === launch.claims.sub));
const score = Number(process.env.TEST_SCORE || 83);
await action({ action: 'score', scoreGiven: score, lineitemUrl: lineitem });
const results = await action({ action: 'results', lineitemUrl: lineitem });
assert.ok(results.response.body.some(r => r.userId === launch.claims.sub && r.resultScore === score));
if (process.env.CREATE_STANDALONE === 'true') {
  const created = await action({ action: 'create-lineitem', resourceLinkId: null, label: 'Harness standalone smoke' });
  await action({ action: 'score', scoreGiven: 77, lineitemUrl: created.response.body.id });
}
if (process.env.LEGACY_LAUNCH_ID) await action({ action: 'outcome', scoreGiven: 91 }, true, process.env.LEGACY_LAUNCH_ID);
console.log(JSON.stringify({ platform: launch.claims.iss, launch: id, checks: summary }, null, 2));
