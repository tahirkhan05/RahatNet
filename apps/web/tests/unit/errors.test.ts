import { describe, it, expect } from 'vitest';
import { AppError, AuthError, ValidationError, toUserMessage } from '@/lib/utils/errors';

describe('AppError', () => {
  it('has correct properties', () => {
    const err = new AppError('TEST_CODE', 'Test message', 400, { field: 'value' });
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('Test message');
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({ field: 'value' });
  });

  it('toApiError returns correct shape', () => {
    const err = new AppError('TEST', 'msg', 500);
    const apiErr = err.toApiError();
    expect(apiErr.code).toBe('TEST');
    expect(apiErr.statusCode).toBe(500);
  });
});

describe('AuthError', () => {
  it('has status 401', () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_REQUIRED');
  });
});

describe('ValidationError', () => {
  it('has status 400', () => {
    const err = new ValidationError({ name: ['required'] });
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({ name: ['required'] });
  });
});

describe('toUserMessage', () => {
  it('returns AppError message directly', () => {
    const err = new AppError('CODE', 'Custom message', 500);
    expect(toUserMessage(err)).toBe('Custom message');
  });

  it('returns generic message for Error', () => {
    expect(toUserMessage(new Error('internal detail'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('returns generic message for unknown values', () => {
    expect(toUserMessage('string error')).toBe('An unexpected error occurred.');
  });
});
