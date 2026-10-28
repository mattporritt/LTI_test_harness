// Deliberately changes one synthetic learner's grades; observer checks Moodle DB state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runPartialScoreScenario } from '../src/scenarios/partial-scores.js';

const { HARNESS_URL: base, HARNESS_TOKEN: token, LAUNCH_ID: id, MOODLE_CONTAINER: container, MOODLE_CMID: cmid, MOODLE_USERID: userId } = process.env;
assert.ok(base && token && id && container && cmid && userId, 'Set HARNESS_URL, HARNESS_TOKEN, LAUNCH_ID, MOODLE_CONTAINER, MOODLE_CMID, MOODLE_USERID');
const policy = process.env.ACCEPT_PARTIAL_SCORES || 'false';
assert.ok(['true', 'false'].includes(policy), 'ACCEPT_PARTIAL_SCORES must be true or false; this asserts policy, it does not configure Moodle');
const remote = `/tmp/lti-harness-observer-${randomUUID()}.php`;
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message || r.stdout);
  return r.stdout;
}
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const launchResponse = await fetch(`${base}/api/launches/${id}`, { headers });
assert.equal(launchResponse.status, 200);
const launch = await launchResponse.json();
assert.equal(launch.version, '1.3');
assert.equal(launch.messageType, 'LtiResourceLinkRequest');
assert.equal(launch.claims.sub, String(userId), 'Observer user must match the actual launched learner');
const lineitemUrl = launch.claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint']?.lineitem;
assert.ok(lineitemUrl, 'Use an activity-associated learner launch');
docker(['cp', fileURLToPath(new URL('./moodle-completion.php', import.meta.url)), `${container}:${remote}`]);
let send, observe, report;
try {
  observe = () => JSON.parse(docker(['exec', container, 'php', remote, process.env.MOODLE_CONFIG || '/var/www/html/config.php', cmid, userId]));
  const setup = observe();
  assert.ok(setup.completionConfigured, 'Configure maximum 100, grade to pass 50, automatic completion on passing grade before running');
  send = async input => {
    const r = await fetch(`${base}/api/launches/${id}/actions`, { method: 'POST', headers, body: JSON.stringify({ ...input, lineitemUrl }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  report = await runPartialScoreScenario({ send, observe, acceptPartial: policy === 'true' });
  report.platform = launch.claims.iss;
  report.launchId = id;
  report.lineitemUrl = lineitemUrl;
  if (!report.passed) process.exitCode = 1;
} finally {
  try {
    if (send) {
      const restoration = await send({ action: 'score', scoreGiven: Number(process.env.RESTORE_SCORE || 83) });
      const restoredState = observe();
      if (report) { report.restoration = restoration; report.restoredState = restoredState; }
      if (!restoration.success) process.exitCode = 1;
    }
    if (report) console.log(JSON.stringify(report, null, 2));
  } finally {
    docker(['exec', container, 'rm', '-f', remote]);
  }
}
