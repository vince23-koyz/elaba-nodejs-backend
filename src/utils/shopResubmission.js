function shouldResetShopForResubmission({ existingStatus, requestedStatus }) {
  const currentStatus = String(existingStatus || '').toLowerCase();
  const nextStatus = typeof requestedStatus === 'string' ? requestedStatus.toLowerCase() : undefined;

  if (currentStatus === 'rejected') {
    return nextStatus === 'pending' || nextStatus === undefined;
  }

  return false;
}

module.exports = { shouldResetShopForResubmission };
