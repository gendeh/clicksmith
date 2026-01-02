import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import * as authController from './controllers/authController';
import * as profileController from './controllers/profileController';
import * as billingController from './controllers/billingController';
import * as imageController from './controllers/imageController';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());

// Webhook must be raw body, so register it before json parser.
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), billingController.handleWebhook);

app.use(express.json());

// Auth Routes
app.post('/api/v1/auth/signup', authController.signup);
app.post('/api/v1/auth/login', authController.login);
app.get('/api/v1/auth/profile', authController.getProfile);

// Profile Routes
app.get('/api/v1/profiles', profileController.listProfiles);
app.get('/api/v1/profiles/:id', profileController.getProfile);
app.post('/api/v1/profiles', profileController.createProfile);
app.put('/api/v1/profiles/:id', profileController.updateProfile);
app.delete('/api/v1/profiles/:id', profileController.deleteProfile);

// Billing Routes
app.post('/api/v1/billing/checkout', billingController.createCheckoutSession);

// Image Matching Proxy
app.post('/api/v1/image/match', imageController.matchImage);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

export default app;
