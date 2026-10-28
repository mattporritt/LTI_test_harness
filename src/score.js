import { insist } from './protocol.js';

export const ACTIVITY_PROGRESS = ['Initialized', 'Started', 'InProgress', 'Submitted', 'Completed'];
export const GRADING_PROGRESS = ['FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady'];

/** Build the exact AGS score body, including deliberate clearing and stale updates. */
export function scorePayload(input, userId) {
  insist(typeof userId === 'string' && userId.length, 'Anonymous launches cannot submit a score');
  const activityProgress = input.activityProgress ?? 'Completed';
  const gradingProgress = input.gradingProgress ?? 'FullyGraded';
  insist(ACTIVITY_PROGRESS.includes(activityProgress), 'Invalid activityProgress');
  insist(GRADING_PROGRESS.includes(gradingProgress), 'Invalid gradingProgress');
  const timestamp = input.timestamp === undefined || input.timestamp === '' ? new Date().toISOString() : input.timestamp;
  insist(typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+(?:Z|[+-]\d\d(?::\d\d)?)$/.test(timestamp) && Number.isFinite(Date.parse(timestamp.replace(/([+-]\d\d)$/, '$1:00'))), 'timestamp must be ISO 8601 with fractional seconds and a timezone');
  const payload = { userId, timestamp, activityProgress, gradingProgress };
  const mode = input.scoreMode ?? (input.scoreGiven === null ? 'null' : 'value');
  insist(['value', 'null', 'omit'].includes(mode), 'scoreMode must be value, null or omit');
  if (mode === 'null') payload.scoreGiven = null;
  if (mode === 'value') {
    insist(['number', 'string'].includes(typeof input.scoreGiven) && String(input.scoreGiven).trim(), 'scoreGiven is required; use scoreMode=omit to deliberately clear it');
    const scoreGiven = Number(input.scoreGiven);
    const scoreMaximum = input.scoreMaximum === undefined ? 100 : Number(input.scoreMaximum);
    insist(Number.isFinite(scoreGiven) && scoreGiven >= 0, 'scoreGiven must be a non-negative number');
    insist(['number', 'string'].includes(typeof (input.scoreMaximum ?? 100)) && Number.isFinite(scoreMaximum) && scoreMaximum > 0, 'scoreMaximum must be a positive number');
    payload.scoreGiven = scoreGiven;
    payload.scoreMaximum = scoreMaximum;
  }
  if (input.comment !== undefined && input.comment !== '') {
    insist(typeof input.comment === 'string' && input.comment.length <= 10000, 'comment must be text of at most 10000 characters');
    payload.comment = input.comment;
  }
  return payload;
}
