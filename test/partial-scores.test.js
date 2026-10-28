import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPartialScoreScenario } from '../src/scenarios/partial-scores.js';

function model(acceptPartial, buggy = false) {
  let grade = null, last = 0;
  return {
    send: async p => {
      const timestamp = Date.parse(p.timestamp);
      if (timestamp >= last) {
        if (p.scoreGiven === null || p.scoreMode === 'omit') { grade = null; last = buggy ? 0 : timestamp; }
        else if (p.gradingProgress === 'FullyGraded' || acceptPartial) { grade = p.scoreGiven; last = timestamp; }
        else if (buggy) { grade = null; last = 0; }
      }
      return { success: true, response: { status: 200 } };
    },
    observe: async () => ({ grade, completion: grade === null ? 0 : grade >= 50 ? 2 : 3 }),
  };
}
for (const acceptPartial of [false, true]) test(`regression assertions accept corrected policy ${acceptPartial}`, async () => {
  const report = await runPartialScoreScenario({ ...model(acceptPartial), time: 0, acceptPartial });
  assert.equal(report.passed, true);
});
test('HTTP 200 does not hide grade erasure or stale update acceptance', async () => {
  const report = await runPartialScoreScenario({ ...model(false, true), time: 0 });
  assert.equal(report.passed, false);
  for (const name of ['pending-after-final', 'stale-final-after-pending', 'stale-final-after-null-clear', 'stale-final-after-omitted-clear']) assert.ok(report.failures.includes(name));
});
test('enabling provisional scores must satisfy passing-grade completion', async () => {
  const report = await runPartialScoreScenario({ ...model(false), time: 0, acceptPartial: true });
  assert.ok(report.failures.includes('pending-passing-score'));
});
