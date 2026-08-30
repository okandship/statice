// Every /v1 response with a body is JSON: { "error": "<code>", "message": "..." }.
// Success bodies never carry `error`, so `"error" in body` is the whole test.
// Every /v1 response carries Cache-Control: no-store, and never an HTML body.

export type ErrorCode =
  | "invalid-request"
  | "unauthorized"
  | "not-found"
  | "method-not-allowed"
  | "length-required"
  | "too-large"
  | "conflict"
  | "upstream"
  | "unavailable";

export function apiJson(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiEmpty(status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

export function apiError(
  status: number,
  error: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return apiJson(status, { error, message, ...(extra ?? {}) }, headers);
}

export const badRequest = (m: string, extra?: Record<string, unknown>) =>
  apiError(400, "invalid-request", m, extra);
export const unauthorized = (m: string) => apiError(401, "unauthorized", m);
export const notFound = (m: string) => apiError(404, "not-found", m);
export const methodNotAllowed = (allow: string) =>
  apiError(405, "method-not-allowed", `allowed: ${allow}`, undefined, { Allow: allow });
export const lengthRequired = (m: string) => apiError(411, "length-required", m);
export const tooLarge = (m: string) => apiError(413, "too-large", m);
export const conflict = (m: string, extra?: Record<string, unknown>) =>
  apiError(422, "conflict", m, extra);
export const upstream = (m: string) => apiError(502, "upstream", m);
export const unavailable = (m: string) => apiError(503, "unavailable", m);
