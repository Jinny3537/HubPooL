export type CodedError = Error & { code: string };

export function codedError(code: string, message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
}

export function isCodedError(err: unknown): err is CodedError {
  return err instanceof Error && typeof (err as CodedError).code === 'string' && (err as CodedError).code.length > 0;
}

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  LOOPBACK_REQUIRED: 403,
  LOOPBACK_ONLY: 403,
  VALIDATION_ERROR: 400,
  IMPORT_VALIDATION_ERROR: 400,
  JIRA_CONFIG_INVALID: 400,
  JIRA_NOT_CONFIGURED: 400,
  LOAD_PLATFORM_FAILED: 400,
  CONNECTION_FAILED: 400,
  PREVIEW_FAILED: 500,
  REMOTE_ERROR: 502,
  REMOTE_TIMEOUT: 502,
  REMOTE_UNREACHABLE: 502,
  SYNC_FAILED: 502,
  PUSH_FAILED: 502,
  PULL_FAILED: 502,
  MERGE_FAILED: 502,
};

export function codedErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}
