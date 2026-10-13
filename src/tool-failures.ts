/** Normalize the error payloads used by REST, MCP and custom tool gateways. */
export function toolFailureDetails(output: unknown, receiptErrorCode?: string): { message: string; errorCode: string; httpStatus?: number } {
  const record = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
  const message = [error.message, record.error, record.message, output].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  const errorCode = receiptErrorCode ?? ([error.errorCode, error.code, record.errorCode, record.code].find(value => typeof value === 'string') as string | undefined);
  const status = [error.httpStatus, error.statusCode, error.status, record.httpStatus, record.statusCode, record.status]
    .map(value => typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN)
    .find(value => Number.isInteger(value) && value >= 400 && value <= 599);
  const matched = /(?:^|[_-])http[\s_:-]*([45]\d{2})\b/i.exec(errorCode ?? '')
    ?? /\b(?:HTTP(?:\s+(?:status(?:\s+code)?|error))?|status\s+code)[\s_:：=-]*([45]\d{2})\b/i.exec(message ?? '');
  const httpStatus = status ?? (matched ? Number(matched[1]) : undefined);
  return { message: (message ?? 'External tool execution failed').slice(0, 2000),
    errorCode: (errorCode ?? (httpStatus ? `http_${httpStatus}` : /timeout|timed[ _-]?out|超时/i.test(message ?? '') ? 'timeout' : 'tool_failed')).slice(0, 100),
    ...(httpStatus === undefined ? {} : { httpStatus }) };
}

/** Only recognized client/target errors are recoverable; ambiguous failures stay fatal. */
export function isRecoverableToolFailure(error: ReturnType<typeof toolFailureDetails>): boolean {
  const { errorCode, message, httpStatus } = error;
  if (/auth|forbidden|permission|access[_ -]?denied|capability|policy|budget|isolat|proxy/i.test(errorCode)) return false;
  if (/capability|policy|budget|isolated|权限|策略|预算/i.test(message)) return false;
  if (/(?:toolkit|gateway|transport).*(?:auth|forbidden|permission|credential|token|HTTP[\s_:-]*(?:401|403))|(?:auth|forbidden|credential|token).*(?:toolkit|gateway|transport)/i.test(message)) return false;
  if (httpStatus === 407) return false;
  if (httpStatus !== undefined) {
    if (/^(?:toolkit|gateway|transport)[_-]http/i.test(errorCode) && (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500)) return false;
    if (/(?:toolkit|gateway|transport)/i.test(message) && !/target|upstream|web[ -]?fetch|fetch|website|https?:\/\/|网页|抓取|目标站/i.test(message)
      && (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500)) return false;
    if (httpStatus < 500) return true;
    return /^http[_-]5\d{2}$/i.test(errorCode) || /target|upstream|web[ -]?fetch|fetch|website|https?:\/\/|网页|抓取|目标站/i.test(message);
  }
  return /timeout|timed[ _-]?out|etimedout|deadline[ _-]?exceeded|超时/i.test(`${errorCode} ${message}`)
    || /^(?:bad_request|invalid_input|validation_error|not_found|gone|rate_limit(?:ed|_exceeded)?|too_many_requests|unprocessable_entity)$/i.test(errorCode);
}
