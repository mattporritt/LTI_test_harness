/** MDL-89973 assertions: HTTP acceptance, actual grade, completion and stale ordering. */
export async function runPartialScoreScenario({ send, observe, acceptPartial = false, time }) {
  const eventTimes = new Map();
  let latestLogical = -1, latestTime = 0;
  async function stamp(offset) {
    if (time !== undefined) return new Date(time + offset).toISOString();
    if (offset > latestLogical) {
      // Moodle grade timestamps may have only second precision. Fresh events must
      // cross that boundary; stale events retain their deliberately older time.
      const delay = Math.max(0, latestTime + 1000 - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      latestTime = Date.now(); latestLogical = offset;
      eventTimes.set(offset, latestTime);
      return new Date(latestTime).toISOString();
    }
    const keys = [...eventTimes.keys()];
    const before = Math.max(...keys.filter(key => key < offset));
    const after = Math.min(...keys.filter(key => key > offset));
    return new Date(Math.floor((eventTimes.get(before) + eventTimes.get(after)) / 2)).toISOString();
  }
  const partialGrade = acceptPartial ? 60 : null;
  const retainedGrade = acceptPartial ? 90 : 80;
  const steps = [
    { name: 'initial-clear', scoreMode: 'omit', activityProgress: 'Initialized', gradingProgress: 'NotReady', at: 0, expected: null },
    { name: 'pending-passing-score', scoreGiven: 60, activityProgress: 'InProgress', gradingProgress: 'Pending', at: 1000, expected: partialGrade },
    { name: 'final-score', scoreGiven: 80, at: 2000, expected: 80 },
    { name: 'pending-after-final', scoreGiven: 90, activityProgress: 'InProgress', gradingProgress: 'Pending', at: 3000, expected: retainedGrade },
    { name: 'stale-final-after-pending', scoreGiven: 10, at: 1500, expected: retainedGrade },
    { name: 'null-clear', scoreGiven: null, activityProgress: 'Initialized', gradingProgress: 'NotReady', at: 4000, expected: null },
    { name: 'stale-final-after-null-clear', scoreGiven: 30, at: 3500, expected: null },
    { name: 'fresh-final-after-clear', scoreGiven: 70, at: 5000, expected: 70 },
    { name: 'omitted-clear', scoreMode: 'omit', activityProgress: 'Initialized', gradingProgress: 'NotReady', at: 6000, expected: null },
    { name: 'stale-final-after-omitted-clear', scoreGiven: 40, at: 5500, expected: null },
  ];
  const observations = [];
  for (const { name, at, expected, ...input } of steps) {
    const request = { action: 'score', scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', ...input, timestamp: await stamp(at) };
    const response = await send(request);
    const actual = await observe();
    const expectedCompletion = expected === null ? 0 : expected >= 50 ? 2 : 3;
    const checks = {
      accepted: response.success === true,
      grade: actual.grade === expected,
      completion: actual.completion === expectedCompletion,
    };
    observations.push({ name, request, serviceStatus: response.response?.status, expected: { grade: expected, completion: expectedCompletion }, actual, checks, passed: Object.values(checks).every(Boolean) });
  }
  return { issue: 'MDL-89973', policy: acceptPartial ? 'accept-partial' : 'ignore-partial', observations, passed: observations.every(row => row.passed), failures: observations.filter(row => !row.passed).map(row => row.name) };
}
