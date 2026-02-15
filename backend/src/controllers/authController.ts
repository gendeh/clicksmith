import { Request, Response } from 'express';
import { auth } from '../config/firebase';
import { requireAuthenticatedUid } from '../middleware/auth';
import { mockDb } from '../store/mockDb';
import { SubscriptionRecord, UserRecord } from '../types';

export const signup = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (auth) {
      const user = await auth.createUser({ email, password });
      const token = await auth.createCustomToken(user.uid);
      res.status(201).json({ userId: user.uid, token });
      return;
    }

    const userId = `mock-${Date.now()}`;
    const record: UserRecord = { uid: userId, email, createdAt: new Date().toISOString() };
    mockDb.createUser(record);
    res.status(201).json({ message: 'User created successfully', userId, token: `dev:${userId}` });
  } catch {
    res.status(500).json({ error: 'Error creating user' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email: string };
    if (auth) {
      const user = await auth.getUserByEmail(email);
      const token = await auth.createCustomToken(user.uid);
      res.status(200).json({ token, userId: user.uid });
      return;
    }

    const knownUser = mockDb.findUserByEmail(email);
    if (!knownUser) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    res.status(200).json({ token: `dev:${knownUser.uid}`, userId: knownUser.uid });
  } catch {
    res.status(401).json({ error: 'Invalid credentials' });
  }
};

export const getProfile = async (req: Request, res: Response) => {
  const uid = requireAuthenticatedUid(req);
  const user = mockDb.getUser(uid);
  const subscription =
    mockDb.getSubscription(uid) ??
    ({
      uid,
      tier: 'free',
      isActive: true,
      updatedAt: new Date().toISOString(),
    } as SubscriptionRecord);

  res.json({
    uid,
    email: user?.email ?? req.query.email ?? 'user@example.com',
    subscription,
  });
};
