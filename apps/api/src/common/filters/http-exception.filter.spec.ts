import { HttpException, HttpStatus, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost(): { host: ArgumentsHost; statusMock: jest.Mock; jsonMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const response = { status: statusMock };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, statusMock, jsonMock };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    // silence the logger — we're testing the response not logs
    (filter as any).logger = { error: jest.fn() };
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns the unified error envelope shape', () => {
    const { host, statusMock, jsonMock } = makeHost();
    filter.catch(new NotFoundException('Task not found'), host);

    expect(statusMock).toHaveBeenCalledWith(404);
    const body = jsonMock.mock.calls[0][0];
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Task not found',
      },
    });
  });

  it('maps common HTTP statuses to stable error codes', () => {
    const cases: [HttpException, number, string][] = [
      [new BadRequestException('x'), 400, 'BAD_REQUEST'],
      [new UnauthorizedException('x'), 401, 'UNAUTHORIZED'],
      [new HttpException('x', HttpStatus.FORBIDDEN), 403, 'FORBIDDEN'],
      [new NotFoundException('x'), 404, 'NOT_FOUND'],
      [new HttpException('x', HttpStatus.CONFLICT), 409, 'CONFLICT'],
      [new HttpException('x', HttpStatus.TOO_MANY_REQUESTS), 429, 'TOO_MANY_REQUESTS'],
    ];

    for (const [ex, status, code] of cases) {
      const { host, statusMock, jsonMock } = makeHost();
      filter.catch(ex, host);
      expect(statusMock).toHaveBeenCalledWith(status);
      expect(jsonMock.mock.calls[0][0].error.code).toBe(code);
    }
  });

  it('collapses class-validator error arrays into "Validation failed"', () => {
    const { host, jsonMock } = makeHost();
    const ex = new HttpException(
      { message: ['email must be an email', 'password too short'], statusCode: 400 },
      400,
    );
    filter.catch(ex, host);
    const body = jsonMock.mock.calls[0][0];
    expect(body.error.message).toBe('Validation failed');
    expect(body.error.details).toEqual(['email must be an email', 'password too short']);
  });

  describe('unhandled Error (info-disclosure defense)', () => {
    it('keeps the generic message in production (does NOT leak the real error)', () => {
      process.env.NODE_ENV = 'production';
      const { host, statusMock, jsonMock } = makeHost();
      filter.catch(new Error('DB connection string: user:p4ss@host'), host);

      expect(statusMock).toHaveBeenCalledWith(500);
      const body = jsonMock.mock.calls[0][0];
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.message).not.toContain('p4ss');
    });

    it('shows the real error in development', () => {
      process.env.NODE_ENV = 'development';
      const { host, jsonMock } = makeHost();
      filter.catch(new Error('Something broke in the inner loop'), host);

      const body = jsonMock.mock.calls[0][0];
      expect(body.error.message).toContain('Something broke');
    });

    it('logs the full error and stack regardless of env', () => {
      const { host } = makeHost();
      const err = new Error('secret');
      filter.catch(err, host);
      expect((filter as any).logger.error).toHaveBeenCalled();
    });
  });
});
