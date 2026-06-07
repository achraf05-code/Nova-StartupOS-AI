// =====================================================================
// Nova StartupOS AI — Stripe Checkout Session Generator (Vercel / Node.js)
// ---------------------------------------------------------------------
// Route:  POST /api/stripe-checkout   (mapped in vercel.json)
//
// Accepts { priceId, userId } from the frontend, creates a secure Stripe
// Checkout Session server-side (the secret key never leaves the server),
// and returns { url } so main.js can redirect the user to Stripe.
// =====================================================================

const Stripe = require('stripe');

// Secret key is read ONLY from Vercel env vars — never hardcoded/exposed.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
// Public site URL used to build success/cancel redirects.
const SITE_URL = process.env.SITE_URL || 'https://nova-startupos-ai.vercel.app';

module.exports = async (req, res) => {
  // ---- CORS preflight ----
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' });
  }

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);

    // ---- Parse request body ----
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const priceId = (body.priceId || '').toString();
    const userId = (body.userId || '').toString();

    if (!priceId) return res.status(400).json({ error: 'priceId is required.' });
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    // ---- Create the Checkout Session (subscription mode) ----
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Tie the session back to our Supabase user for webhook reconciliation.
      client_reference_id: userId,
      metadata: { supabase_user_id: userId },
      success_url: SITE_URL + '/?billing=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: SITE_URL + '/?billing=cancelled'
    });

    // Return the hosted Checkout URL for the frontend to redirect to.
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Could not create checkout session.' });
  }
};
