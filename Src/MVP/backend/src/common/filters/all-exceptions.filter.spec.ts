import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from '../exceptions/app.exception';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: jest.Mock;
  let status: jest.Mock;
  let host: ArgumentsHost;

  /** Returns the single response body the filter wrote. */
  function sentBody() {
    return json.mock.calls[0][0];
  }

  /** Returns the HTTP status the filter set. */
  function sentStatus() {
    return status.mock.calls[0][0];
  }

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    filter = new AllExceptionsFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes an application exception through with its own code', () => {
    filter.catch(new AppException('CREDENTIAL_INVALID', 'Token scaduto', HttpStatus.FORBIDDEN), host);

    expect(sentStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(sentBody()).toEqual({ code: 'CREDENTIAL_INVALID', message: 'Token scaduto' });
  });

  it('reports validation failures with the list of offending fields', () => {
    const exception = new BadRequestException({
      message: ['email must be an email', 'password should not be empty'],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, host);

    expect(sentStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(sentBody()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed.',
      details: ['email must be an email', 'password should not be empty'],
    });
  });

  it('still reports a detail when the validation error carries a bare string', () => {
    filter.catch(new BadRequestException('Formato non valido'), host);

    expect(sentBody().details).toEqual(['Formato non valido']);
  });

  const builtIns: [HttpException, number, string][] = [
    [new UnauthorizedException(), HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'],
    [new ForbiddenException(), HttpStatus.FORBIDDEN, 'FORBIDDEN'],
    [new NotFoundException(), HttpStatus.NOT_FOUND, 'NOT_FOUND'],
    [new ConflictException(), HttpStatus.CONFLICT, 'CONFLICT'],
    [
      new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS),
      HttpStatus.TOO_MANY_REQUESTS,
      'TOO_MANY_REQUESTS',
    ],
  ];

  it.each(builtIns)('gives a built-in %#  its own error code', (exception, expectedStatus, code) => {
    filter.catch(exception, host);

    expect(sentStatus()).toBe(expectedStatus);
    expect(sentBody().code).toBe(code);
  });

  it('falls back to UPSTREAM for an HTTP status it has no code for', () => {
    filter.catch(new HttpException('Gateway timeout', HttpStatus.GATEWAY_TIMEOUT), host);

    expect(sentStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(sentBody().code).toBe('UPSTREAM');
  });

  it('turns an unexpected error into a 500 without leaking its message', () => {
    // The message of an unhandled error can carry connection strings, file
    // paths or stack detail: it belongs in the log, not in the response.
    filter.catch(new Error('Mongo connection string mongodb://admin:pw@host'), host);

    expect(sentStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sentBody()).toEqual({ code: 'UPSTREAM', message: 'An internal error occurred.' });
    expect(JSON.stringify(sentBody())).not.toContain('mongodb://');
  });

  it('logs the unexpected error so it is not lost', () => {
    const logged = jest.spyOn(Logger.prototype, 'error');

    filter.catch(new Error('guasto imprevisto'), host);

    expect(logged).toHaveBeenCalled();
  });

  it('handles something thrown that is not even an Error', () => {
    filter.catch('una stringa lanciata a mano', host);

    expect(sentStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sentBody().code).toBe('UPSTREAM');
  });

  it('answers exactly once per exception', () => {
    filter.catch(new NotFoundException(), host);

    expect(status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
  });
});
