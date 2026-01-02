import { Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../config/firebase';
import { mockDb } from '../store/mockDb';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_mock', {
  apiVersion: '2023-10-16',
});

export const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const { priceId, customerEmail, uid } = req.body;
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

    if (!process.env.STRIPE_SECRET_KEY) {
      res.json({ sessionId: 'mock-session-id', url: `${clientUrl}/mock-checkout` });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${clientUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/cancel`,
      customer_email: customerEmail,
      metadata: { uid: uid || 'mock-user' },
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    res.status(500).json({ error: 'Error creating checkout session' });
  }
};

export const handleWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;

  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig as string, endpointSecret);
    } else {
      event = req.body as Stripe.Event;
    }
  } catch (err: any) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object as Stripe.Checkout.Session;
      const uid = session.metadata?.uid || 'mock-user';
      if (db) {
        await db.collection('subscriptions').doc(uid).set({
          uid,
          tier: 'pro',
          isActive: true,
          stripeSubscriptionId: session.subscription,
          updatedAt: new Date().toISOString(),
        });
      } else {
        mockDb.setSubscription({
          uid,
          tier: 'pro',
          isActive: true,
          stripeSubscriptionId: session.subscription?.toString(),
          updatedAt: new Date().toISOString(),
        });
      }
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.send();
};
