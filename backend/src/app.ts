import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import * as authController from './controllers/authController';
import * as profileController from './controllers/profileController';
import * as billingController from './controllers/billingController';
import * as imageController from './controllers/imageController';
import { authenticateRequest } from './middleware/auth';
import { validateBody } from './middleware/validate';
import {
  validateCheckoutBody,
  validateLoginBody,
  validateProfileCreateBody,
  validateProfileUpdateBody,
  validateSignupBody,
} from './validation/schemas';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());

// Webhook must be raw body, so register it before json parser.
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), billingController.handleWebhook);

app.use(express.json());

// Auth Routes
app.post('/api/v1/auth/signup', validateBody(validateSignupBody), authController.signup);
app.post('/api/v1/auth/login', validateBody(validateLoginBody), authController.login);
app.get('/api/v1/auth/profile', authenticateRequest, authController.getProfile);

// Profile Routes
app.get('/api/v1/profiles', authenticateRequest, profileController.listProfiles);
app.get('/api/v1/profiles/:id', authenticateRequest, profileController.getProfile);
app.post('/api/v1/profiles', authenticateRequest, validateBody(validateProfileCreateBody), profileController.createProfile);
app.put('/api/v1/profiles/:id', authenticateRequest, validateBody(validateProfileUpdateBody), profileController.updateProfile);
app.delete('/api/v1/profiles/:id', authenticateRequest, profileController.deleteProfile);

// Billing Routes
app.post('/api/v1/billing/checkout', authenticateRequest, validateBody(validateCheckoutBody), billingController.createCheckoutSession);

// Image Matching Proxy
app.post('/api/v1/image/match', imageController.matchImage);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

export default app;
