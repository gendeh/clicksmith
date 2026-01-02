import { Request, Response } from 'express';
import { auth } from '../config/firebase';
import { mockDb } from '../store/mockDb';
import { SubscriptionRecord, UserRecord } from '../types';

function getUserId(req: Request) {
  return (req.headers['x-user-id'] as string) || 'mock-user';
}

export const signup = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (auth) {
      const user = await auth.createUser({ email, password });
      const token = await auth.createCustomToken(user.uid);
      res.status(201).json({ userId: user.uid, token });
      return;
    }

    const userId = `mock-${Date.now()}`;
    const record: UserRecord = { uid: userId, email, createdAt: new Date().toISOString() };
    mockDb.createUser(record);
    res.status(201).json({ message: 'User created successfully', userId });
  } catch (error) {
    res.status(500).json({ error: 'Error creating user' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (auth) {
      const user = await auth.getUserByEmail(email);
      const token = await auth.createCustomToken(user.uid);
      res.status(200).json({ token, userId: user.uid });
      return;
    }

    res.status(200).json({ token: 'mock-jwt-token', userId: getUserId(req) });
  } catch (error) {
    res.status(401).json({ error: 'Invalid credentials' });
  }
};

export const getProfile = async (req: Request, res: Response) => {
  const uid = getUserId(req);
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
    email: req.query.email ?? 'user@example.com',
    subscription,
  });
};
