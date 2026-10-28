import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePayload, ACTIVITY_PROGRESS, GRADING_PROGRESS } from '../src/score.js';

test('every AGS progress value is preserved, not forced to FullyGraded', () => {
  for (const gradingProgress of GRADING_PROGRESS) for (const activityProgress of ACTIVITY_PROGRESS) {
    assert.equal(scorePayload({ scoreGiven: 60, gradingProgress, activityProgress }, 'learner').gradingProgress, gradingProgress);
  }
});
test('score omission and null are distinct deliberate wire representations', () => {
  assert.equal(scorePayload({ scoreGiven: null }, 'learner').scoreGiven, null);
  assert.equal(Object.hasOwn(scorePayload({ scoreMode: 'omit' }, 'learner'), 'scoreGiven'), false);
  assert.throws(() => scorePayload({}, 'learner'), /required/);
  assert.throws(() => scorePayload({ scoreGiven: null, scoreMode: 'value' }, 'learner'), /required/);
});
test('scales, decimals, extra credit and timestamps are supported', () => {
  const input = { scoreGiven: 1.2, scoreMaximum: 1, timestamp: '2020-01-01T00:00:00.123Z' };
  assert.deepEqual(scorePayload(input, 'learner'), { userId: 'learner', timestamp: input.timestamp, activityProgress: 'Completed', gradingProgress: 'FullyGraded', scoreGiven: 1.2, scoreMaximum: 1 });
});
test('malformed numeric values, statuses and timestamps do not become grade clears', () => {
  for (const input of [{ scoreGiven: false }, { scoreGiven: [] }, { scoreGiven: -1 }, { scoreGiven: 'x' }, { scoreGiven: 1, scoreMaximum: false }, { scoreMode: 'clear' }, { scoreGiven: 1, timestamp: '2020-01-01' }]) assert.throws(() => scorePayload(input, 'learner'));
});


test('explicit invalid timestamps fail, short ISO timezone offsets remain unchanged', () => {
  for (const timestamp of [false, null, 123]) assert.throws(() => scorePayload({ scoreGiven: 60, timestamp }, 'learner'));
  const timestamp = '2020-01-01T00:00:00.123+00';
  assert.equal(scorePayload({ scoreGiven: 60, timestamp }, 'learner').timestamp, timestamp);
});
