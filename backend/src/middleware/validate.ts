import { NextFunction, Request, Response } from 'express';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type Validator<T> = (value: unknown) => ValidationResult<T>;

export function validateBody<T>(validator: Validator<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = validator(req.body);
    if (!result.ok) {
      res.status(400).json({
        error: 'Bad Request',
        code: 'E_SCHEMA_INVALID',
        details: result.errors,
      });
      return;
    }
    req.body = result.value;
    next();
  };
}
