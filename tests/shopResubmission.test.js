const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldResetShopForResubmission } = require('../src/utils/shopResubmission');

test('rejected shops reset to pending when the owner edits details again', () => {
  assert.equal(shouldResetShopForResubmission({ existingStatus: 'rejected', requestedStatus: undefined }), true);
  assert.equal(shouldResetShopForResubmission({ existingStatus: 'rejected', requestedStatus: 'pending' }), true);
  assert.equal(shouldResetShopForResubmission({ existingStatus: 'active', requestedStatus: undefined }), false);
});
