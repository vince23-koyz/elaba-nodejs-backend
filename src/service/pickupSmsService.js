const { sendSms } = require('./otpService');

const PICKUP_READY_SMS_ENABLED = process.env.PICKUP_READY_SMS_ENABLED === 'true';

async function sendPickupReadySms({ phoneNumber, customerFirstName, bookingId, totalAmount, paymentMethod }) {
  const normalizedPaymentMethod = String(paymentMethod || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  const isCashOnDelivery = ['cash', 'cod', 'cashondelivery'].includes(normalizedPaymentMethod);
  let paymentReminder = '';

  if (isCashOnDelivery) {
    const amount = Number(totalAmount);
    if (!Number.isFinite(amount)) {
      throw new Error(`Booking amount is invalid for booking #${bookingId}`);
    }
    const formattedAmount = amount.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    paymentReminder = ` Please prepare PHP ${formattedAmount} for payment.`;
  }

  const suffix = `, booking #${bookingId} is out for delivery.${paymentReminder} - eLaba`;
  const name = String(customerFirstName || '').trim();
  const greeting = name
    ? `Hi ${name.slice(0, Math.max(0, 160 - 3 - suffix.length))}`
    : 'Hi';
  const message = `${greeting}${suffix}`.slice(0, 160);

  if (!PICKUP_READY_SMS_ENABLED) {
    console.log(
      `[SMS preview] Pickup booking #${bookingId} delivery status changed to out_for_delivery. Payment method: ${paymentMethod || 'unknown'}. SMS is disabled; no message was sent (${message.length}/160 chars): "${message}"`
    );
    return false;
  }

  if (!phoneNumber) {
    throw new Error(`Customer phone number is missing for booking #${bookingId}`);
  }

  await sendSms(phoneNumber, message);
  console.log(`Pickup out-for-delivery SMS accepted by Semaphore for booking #${bookingId} (${message.length}/160 chars)`);
  return true;
}

module.exports = { sendPickupReadySms };
