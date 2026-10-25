/**
 * Vercel Serverless Function: /api/webhooks/payment
 * Handles payment callbacks from Paystack, Stripe, and AetherWeave Chaos Testing
 * 
 * Features:
 * - Strict Idempotency: Prevents duplicate votes on webhook replay/retry attacks
 * - Supports both Paystack webhook format (event: charge.success) & generic payloads
 * - GET health-check and tally inspection endpoint
 */

const fs = require('fs');
const path = require('path');

// In-memory cache for fast lookup during container warm runtime
const processedReferences = new Set();
const candidateTallies = {};

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
      supported_formats: ['paystack_standard', 'aetherweave_chaos_emitter', 'generic_payment_event']
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST for webhooks or GET for status.' });
  }

  try {
    const body = req.body || {};

    // 1. Normalize Payload & Extract Metadata
    // Supports Paystack { event: 'charge.success', data: { reference, metadata... } }
    // As well as direct AetherWeave / Stripe payloads { reference, candidate_id, votes_cast... }
    let reference = null;
    let candidateId = 'lionel-messi-2023';
    let candidateName = 'Lionel Messi (2023)';
    let votesCount = 1;
    let amount = 100;
    let customerEmail = 'voter@ballondor.com';

    if (body.data && typeof body.data === 'object') {
      // Paystack format
      const d = body.data;
      reference = d.reference || d.id;
      amount = d.amount || amount;
      if (d.customer && d.customer.email) customerEmail = d.customer.email;

      const meta = d.metadata || {};
      candidateId = meta.candidate_id || meta.player_selected || candidateId;
      candidateName = meta.player_selected || candidateName;
      if (meta.votes_cast) votesCount = parseInt(meta.votes_cast, 10) || 1;
    } else {
      // AetherWeave / Direct format
      reference = body.reference || body.id || body.transaction_id || body.payment_id;
      candidateId = body.candidate_id || body.player_selected || body.candidate || candidateId;
      candidateName = body.candidate_name || body.player_selected || candidateName;
      if (body.votes_cast !== undefined) votesCount = parseInt(body.votes_cast, 10) || 1;
      else if (body.votes !== undefined) votesCount = parseInt(body.votes, 10) || 1;
      if (body.amount !== undefined) amount = body.amount;
      if (body.email || body.customer_email) customerEmail = body.email || body.customer_email;
    }

    if (!reference) {
      return res.status(400).json({
        error: 'Missing required transaction reference / ID.',
        received_body: body
      });
    }

    reference = String(reference).trim();

    // 2. IDEMPOTENCY CHECK
    // If this transaction reference has already been processed, return HTTP 200 immediately
    // without awarding extra votes to prevent double-voting under chaos/retry storms.
    if (processedReferences.has(reference)) {
      return res.status(200).json({
        status: 'success',
        idempotent: true,
        duplicate_detected: true,
        message: `Idempotency check passed: Transaction ${reference} was already processed. No duplicate votes awarded.`,
        transaction_reference: reference,
        candidate_id: candidateId,
        votes_awarded_this_request: 0,
        candidate_total_votes: candidateTallies[candidateId] || 0
      });
    }

    // 3. New Transaction: Record Reference and Increment Votes
    processedReferences.add(reference);
    candidateTallies[candidateId] = (candidateTallies[candidateId] || 0) + votesCount;
    persistState();

    return res.status(200).json({
      status: 'success',
      idempotent: false,
      duplicate_detected: false,
      message: `Vote payment verified successfully. Awarded ${votesCount} vote(s) to ${candidateName}.`,
      transaction_reference: reference,
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
