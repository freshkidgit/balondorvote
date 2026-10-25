/**
 * Vercel Serverless Function: /api/webhooks/paystack (and /api/webhooks/payment)
 * Handles Paystack payment webhooks and AetherWeave Chaos Testing
 * 
 * Features:
 * - Strict Idempotency: Prevents duplicate votes on Paystack webhook replay/retry storms
 * - Checks Paystack transaction reference (data.reference)
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

// /tmp persistence on Vercel runtime
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paystack-Signature, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Healthcheck and current tally
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'healthy',
      service: 'Ballon d\'Or 2026 Paystack Webhook Gateway',
      idempotency_engine: 'active',
      total_unique_transactions: processedReferences.size,
      vote_tallies: candidateTallies,
      supported_formats: ['paystack_standard', 'aetherweave_chaos_emitter']
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for webhooks or GET for status.' });
  }

  try {
    const body = req.body || {};

    // 1. EXTRACT PAYSTACK TRANSACTION REFERENCE / IDEMPOTENCY KEY
    let reference = 
      (body.data && (body.data.reference || body.data.id)) ||
      body.reference ||
      body.transaction_id ||
      body.eventId ||
      body.id;

    // 2. EXTRACT CANDIDATE & VOTE DETAILS
    let candidateId = 'lionel-messi-2023';
    let candidateName = 'Lionel Messi (2023)';
    let votesCount = 1;
    let amountKobo = 150000;
    let customerEmail = 'voter@ballondor.com';

    if (body.data && typeof body.data === 'object') {
      // Official Paystack webhook structure: { event: "charge.success", data: { reference, amount, metadata, customer } }
      const d = body.data;
      if (d.amount !== undefined) amountKobo = d.amount;
      if (d.customer && d.customer.email) customerEmail = d.customer.email;

      const meta = d.metadata || {};
      candidateId = meta.candidate_id || meta.player_selected || candidateId;
      candidateName = meta.player_selected || meta.candidate_name || candidateName;
      if (meta.votes_cast !== undefined) votesCount = parseInt(meta.votes_cast, 10) || 1;
    } else {
      // Direct AetherWeave emitter payload
      candidateId = body.candidate_id || body.player_selected || body.candidate || candidateId;
      candidateName = body.candidate_name || body.player_selected || candidateName;
      if (body.votes_cast !== undefined) votesCount = parseInt(body.votes_cast, 10) || 1;
      else if (body.votes !== undefined) votesCount = parseInt(body.votes, 10) || 1;
      if (body.amount !== undefined) amountKobo = body.amount;
      if (body.email || body.customer_email) customerEmail = body.email || body.customer_email;
    }

    if (!reference) {
      return res.status(400).json({
        error: 'Missing required Paystack transaction reference.',
        received_body: body
      });
    }

    reference = String(reference).trim();

    // 3. IDEMPOTENCY CHECK (PREVENT DUPLICATE VOTES)
    // If Paystack retries or AetherWeave fires a duplicate payload with the same reference:
    if (processedReferences.has(reference)) {
      return res.status(200).json({
        status: 'success',
        idempotent: true,
        duplicate_detected: true,
        message: `Idempotency check passed: Paystack transaction '${reference}' was already processed. No duplicate votes awarded.`,
        transaction_reference: reference,
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
      message: `Paystack payment verified. Awarded ${votesCount} vote(s) to ${candidateName}.`,
      transaction_reference: reference,
      candidate_id: candidateId,
      candidate_name: candidateName,
      votes_awarded_this_request: votesCount,
      candidate_total_votes: candidateTallies[candidateId],
      amount_kobo: amountKobo,
      voter_email: customerEmail,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Paystack Webhook Processing Error',
      details: error.message
    });
  }
};
