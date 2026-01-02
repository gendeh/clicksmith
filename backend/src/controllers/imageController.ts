import { Request, Response } from 'express';

export const matchImage = async (req: Request, res: Response) => {
  try {
    const endpoint = process.env.IMAGE_SERVICE_URL || 'http://localhost:5001';
    const response = await fetch(`${endpoint}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const payload = await response.json();
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(500).json({ error: 'Image match failed' });
  }
};
