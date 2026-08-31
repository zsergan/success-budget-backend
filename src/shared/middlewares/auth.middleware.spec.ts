import * as jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from './auth.middleware';

describe('AuthMiddleware', () => {
  const middleware = new AuthMiddleware();
  const originalSecret = process.env.JWT_SECRET;

  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock<NextFunction>;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    req = { headers: {} };
    res = { status: statusMock as unknown as Response['status'] };
    next = jest.fn();
  });

  it('rejects requests with no Authorization header', () => {
    middleware.use(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed Authorization header with no token', () => {
    req.headers = { authorization: 'Bearer' };

    middleware.use(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired token', () => {
    req.headers = { authorization: 'Bearer not-a-real-token' };

    middleware.use(req as Request, res as Response, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid token and attaches the decoded payload to the request', () => {
    const token = jwt.sign({ id: 42 }, process.env.JWT_SECRET);
    req.headers = { authorization: `Bearer ${token}` };

    middleware.use(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
    expect((req as unknown as { user: { id: number } }).user.id).toBe(42);
  });
});
