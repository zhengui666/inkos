import { expect, it } from 'vitest';
import { reviewIssueCount } from './review-status.js';
it('does not warn on positive or resolved coverage; retains issues and uncertain legacy findings', () => {
  expect(reviewIssueCount([{ assessment: 'observation' }, { assessment: 'resolved' }, { category: 'scope' }])).toBe(0);
  expect(reviewIssueCount([{ assessment: 'issue' }, { assessment: 'unavailable' }, { code: 'legacy-finding' }])).toBe(3);
});
