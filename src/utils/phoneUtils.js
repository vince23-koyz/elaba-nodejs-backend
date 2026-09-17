const normalizePhoneNumber = (phoneNumber) => {
  const cleanPhone = (phoneNumber || '').replace(/\D/g, '');

  if (!cleanPhone) {
    return '';
  }

  if (cleanPhone.startsWith('63') && cleanPhone.length >= 12) {
    return cleanPhone;
  }

  if (cleanPhone.startsWith('0') && cleanPhone.length >= 11) {
    return `63${cleanPhone.slice(1)}`;
  }

  if (cleanPhone.startsWith('9') && cleanPhone.length >= 10) {
    return `63${cleanPhone}`;
  }

  return cleanPhone;
};

module.exports = {
  normalizePhoneNumber,
};
