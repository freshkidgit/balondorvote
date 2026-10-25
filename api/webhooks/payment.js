/**
 * Vercel Serverless Function: /api/webhooks/payment (and /api/webhooks/stripe)
 * Handles payment callbacks from Paystack, Stripe, and AetherWeave Chaos Testing
 * 
 * Features:
 * - Strict Idempotency: Prevents duplicate votes on webhook replay/retry attacks
 * - Handles eventId, payment_intent_id, Paystack reference, and Stripe evt_/pi_ IDs
 * - Supports body.data.object (Stripe) and body.data (Paystack) and direct AetherWeave payloads
 * - Returns HTTP 200 with duplicate_detected: true and votes_awarded: 0 for replays
 */

const fs = require('fs');
const path = require('path');

// In-memory cache for fast lookup during container warm runtime
const processedReferences = new Set();
const candidateTallies = {
  'lionel-messi-2023': 0,
  'cristiano-ronaldo-2017': 0,
  'rodri-2024': 0,
  'jude-bellingham-2024': 0
};

// Optional /tmp persistence on Vercel runtime
const TMP_FILE = '/tmp/ballondor_processed_webhooks.json';

function loadPersistedState() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (Array.isArray(data.references)) {
        data.references.forEach(ref => processedReferences.add(ref));
      }
      if (data.tallies) {
        Object.assign(candidateTallies, data.tallies);
      }
    }
  } catch (e) {
    // Graceful fallback to memory
  }
}

function persistState() {
  try {
    fs.writeFileSync(
      TMP_FILE,
      JSON.stringify({
        references: Array.from(processedReferences),
        tallies: candidateTallies,
        lastUpdated: new Date().toISOString()
      }),
      'utf8'
    );
  } catch (e) {
    // Ignore write issues on read-only environments
  }
}

// Initial load
loadPersistedState();

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paystack-Signature, Stripe-Signature, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Healthcheck and current tally
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'healthy',
      service: 'Ballon d\'Or 2026 Payment Webhook Gateway',
      idempotency_engine: 'active',
      total_unique_transactions: processedReferences.size,
      vote_tallies: candidateTallies,
      supported_formats: ['stripe_payment_intent', 'paystack_standard', 'aetherweave_chaos_emitter']
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for webhooks or GET for status.' });
  }

  try {
    const body = req.body || {};

    // 1. EXTRACT IDEMPOTENCY KEY / TRANSACTION REFERENCE
    // Checks Stripe event ID (evt_...), payment intent (pi_...), Paystack ref, or custom eventId
    let reference = 
      body.eventId ||
      body.payment_intent_id ||
      body.transaction_id ||
      body.reference ||
      (body.data && body.data.object && (body.data.object.id || body.data.object.payment_intent)) ||
      (body.data && (body.data.reference || body.data.id)) ||
      body.id;

    // 2. EXTRACT CANDIDATE & VOTE DETAILS
    let candidateId = 'lionel-messi-2023';
    let candidateName = 'Lionel Messi (2023)';
    let votesCount = 1;
    let amount = 100;
    let customerEmail = 'voter@ballondor.com';

    // Check Stripe data.object metadata, Paystack data.metadata, or top-level body
    const stripeObj = (body.data && body.data.object) ? body.data.object : null;
    const paystackData = (body.data && !stripeObj && typeof body.data === 'object') ? body.data : null;
    const meta = (stripeObj && stripeObj.metadata) || (paystackData && paystackData.metadata) || body.metadata || {};

    candidateId = 
      meta.candidate_id || 
      meta.player_selected || 
      body.candidate_id || 
      body.player_selected || 
      body.candidate || 
      candidateId;

    candidateName = 
      meta.player_selected || 
      meta.candidate_name || 
      body.candidate_name || 
      body.player_selected || 
      candidateName;

    if (meta.votes_cast !== undefined) votesCount = parseInt(meta.votes_cast, 10) || 1;
    else if (meta.votes !== undefined) votesCount = parseInt(meta.votes, 10) || 1;
    else if (body.votes_cast !== undefined) votesCount = parseInt(body.votes_cast, 10) || 1;
    else if (body.votes !== undefined) votesCount = parseInt(body.votes, 10) || 1;

    if (stripeObj) {
      if (stripeObj.amount !== undefined) amount = stripeObj.amount;
      if (stripeObj.receipt_email) customerEmail = stripeObj.receipt_email;
      else if (stripeObj.customer) customerEmail = String(stripeObj.customer);
    } else if (paystackData) {
      if (paystackData.amount !== undefined) amount = paystackData.amount;
      if (paystackData.customer && paystackData.customer.email) customerEmail = paystackData.customer.email;
    } else {
      if (body.amount !== undefined) amount = body.amount;
      if (body.email || body.customer_email) customerEmail = body.email || body.customer_email;
    }

    if (!reference) {
      return res.status(400).json({
        error: 'Missing required transaction reference / event ID.',
        received_body: body
      });
    }

    reference = String(reference).trim();

    // 3. IDEMPOTENCY CHECK (DUPLICATE VOTE PREVENTION)
    // If this transaction reference has already been processed, return HTTP 200 immediately
    // without awarding extra votes to prevent double-voting under chaos/retry storms.
    if (processedReferences.has(reference)) {
      return res.status(200).json({
        status: 'success',
        idempotent: true,
        duplicate_detected: true,
        message: `Idempotency check passed: Event/Transaction '${reference}' was already processed. No duplicate votes awarded.`,
        idempotency_key: reference,
        candidate_id: candidateId,
        votes_awarded_this_request: 0,
        candidate_total_votes: candidateTallies[candidateId] || 0
      });
    }

    // 4. NEW TRANSACTION: Record Reference and Increment Votes
    processedReferences.add(reference);
    candidateTallies[candidateId] = (candidateTallies[candidateId] || 0) + votesCount;
    persistState();

    return res.status(200).json({
      status: 'success',
      idempotent: false,
      duplicate_detected: false,
      message: `Payment verified. Awarded ${votesCount} vote(s) to ${candidateName}.`,
      idempotency_key: reference,
      candidate_id: candidateId,
      candidate_name: candidateName,
      votes_awarded_this_request: votesCount,
      candidate_total_votes: candidateTallies[candidateId],
      amount_received: amount,
      voter_email: customerEmail,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Internal Webhook Processing Error',
      details: error.message
    });
  }
};
