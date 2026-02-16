'use strict';

function createCorrelationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTrace(scope, meta = {}) {
  const correlationId = createCorrelationId();
  const startedAt = Date.now();
  return { scope, correlationId, startedAt, meta };
}

function elapsedMs(trace) {
  return Date.now() - trace.startedAt;
}

function logInfo(trace, message, data) {
  const payload = {
    level: 'info',
    scope: trace.scope,
    correlationId: trace.correlationId,
    elapsedMs: elapsedMs(trace),
    message,
  };
  if (data !== undefined) payload.data = data;
  console.log('[IPC]', JSON.stringify(payload));
}

function logError(trace, code, message, err, details) {
  const payload = {
    level: 'error',
    scope: trace.scope,
    correlationId: trace.correlationId,
    elapsedMs: elapsedMs(trace),
    code,
    message,
  };
  if (details !== undefined) payload.details = details;
  if (err) payload.cause = String(err?.message || err);
  console.error('[IPC]', JSON.stringify(payload));
}

function ok(trace, data) {
  return {
    ok: true,
    data,
    meta: { correlationId: trace.correlationId, elapsedMs: elapsedMs(trace) },
  };
}

function fail(trace, code, message, details, err) {
  logError(trace, code, message, err, details);
  return {
    ok: false,
    error: { code, message, details: details ?? null },
    meta: { correlationId: trace.correlationId, elapsedMs: elapsedMs(trace) },
  };
}

function normalizeErrorMessage(error, fallback = 'Operation failed.') {
  const msg = String(error?.message || '').trim();
  if (!msg) return fallback;

  if (/timeout/i.test(msg)) return 'The request timed out.';
  if (/ECONNREFUSED|ENOTFOUND|network/i.test(msg)) return 'Network or provider connection failed.';
  return msg;
}

module.exports = {
  createTrace,
  logInfo,
  ok,
  fail,
  normalizeErrorMessage,
};
