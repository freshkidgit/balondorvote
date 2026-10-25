const paymentWebhookHandler = require('./webhooks/payment');

module.exports = async function handler(req, res) {
  return paymentWebhookHandler(req, res);
};
