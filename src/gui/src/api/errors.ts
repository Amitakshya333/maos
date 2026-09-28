/**
 * UI1-02: Client Error Hierarchy
 *
 * Typed error classes providing structured error representation for the MAOS GUI.
 * Complies with the F3 OpenAPI standard error envelope:
 *   { error: { code: string; message: string; details?: unknown } }
 */

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;
  public readonly correlationId?: string;

  constructor(
    message: string,
    code = 'INTERNAL_ERROR',
    status = 500,
    details?: unknown,
    correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.correlationId = correlationId;
  }
}

export class NetworkError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 'NETWORK_ERROR', 0, details);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends ApiError {
  constructor(message = 'Request timed out', details?: unknown) {
    super(message, 'TIMEOUT', 408, details);
    this.name = 'TimeoutError';
  }
}

export class SchemaVersionError extends ApiError {
  public readonly receivedVersion: unknown;
  public readonly expectedVersion: number;

  constructor(receivedVersion: unknown, expectedVersion = 1, entityName = 'Entity') {
    super(
      `Incompatible schema version for ${entityName}: expected ${expectedVersion}, received ${String(receivedVersion)}`,
      'INCOMPATIBLE_SCHEMA_VERSION',
      422,
      { receivedVersion, expectedVersion, entityName },
    );
    this.name = 'SchemaVersionError';
    this.receivedVersion = receivedVersion;
    this.expectedVersion = expectedVersion;
  }
}

export class RuntimeValidationError extends ApiError {
  public readonly validationErrors: string[];

  constructor(entityName: string, validationErrors: string[], details?: unknown) {
    super(
      `Runtime validation failed for ${entityName}: ${validationErrors.join('; ')}`,
      'VALIDATION_FAILED',
      422,
      { entityName, validationErrors, details },
    );
    this.name = 'RuntimeValidationError';
    this.validationErrors = validationErrors;
  }
}

export class IdempotencyConflictError extends ApiError {
  constructor(message: string, details?: unknown, correlationId?: string) {
    super(message, 'IDEMPOTENCY_CONFLICT', 409, details, correlationId);
    this.name = 'IdempotencyConflictError';
  }
}

export class ScopeMismatchError extends ApiError {
  constructor(message: string, details?: unknown, correlationId?: string) {
    super(message, 'PROJECT_SCOPE_MISMATCH', 400, details, correlationId);
    this.name = 'ScopeMismatchError';
  }
}

export class ForbiddenLoopbackError extends ApiError {
  constructor(message = 'Access forbidden: loopback only', details?: unknown, correlationId?: string) {
    super(message, 'FORBIDDEN_NON_LOOPBACK', 403, details, correlationId);
    this.name = 'ForbiddenLoopbackError';
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = 'Payload exceeds maximum allowed size', details?: unknown, correlationId?: string) {
    super(message, 'PAYLOAD_TOO_LARGE', 413, details, correlationId);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Maps raw HTTP response and status code to an appropriate typed ApiError instance.
 */
export function mapHttpError(
  status: number,
  body: unknown,
  correlationId?: string,
): ApiError {
  let code = 'HTTP_ERROR';
  let message = `HTTP ${status}`;
  let details: unknown = undefined;

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (record.error && typeof record.error === 'object') {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.code === 'string') code = errObj.code;
      if (typeof errObj.message === 'string') message = errObj.message;
      if (errObj.details !== undefined) details = errObj.details;
    } else if (typeof record.code === 'string') {
      code = record.code;
      if (typeof record.message === 'string') message = record.message;
    }
  }

  switch (status) {
    case 400:
      if (code.includes('SCOPE') || code.includes('PROJECT')) {
        return new ScopeMismatchError(message, details, correlationId);
      }
      return new ApiError(message, code, status, details, correlationId);
    case 403:
      return new ForbiddenLoopbackError(message, details, correlationId);
    case 408:
      return new TimeoutError(message, details);
    case 409:
      return new IdempotencyConflictError(message, details, correlationId);
    case 413:
      return new PayloadTooLargeError(message, details, correlationId);
    default:
      return new ApiError(message, code, status, details, correlationId);
  }
}
