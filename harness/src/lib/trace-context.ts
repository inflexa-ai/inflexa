/**
 * Hono middleware for W3C Trace Context extraction.
 *
 * Hono's HTTP server is not auto-instrumented by OTEL (which patches Node's
 * `http` module, not Hono's request handling). This middleware manually
 * extracts the `traceparent` header from incoming requests, creates an OTEL
 * server span, and wraps the handler in `context.with()` so the OtelBridge
 * and any downstream code see the correct parent span via `context.active()`.
 */

import { trace, context, propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";

const tracer = trace.getTracer("cortex.http");

/**
 * Middleware that extracts W3C trace context from incoming HTTP headers and
 * creates a server span. Must be registered before all other middleware so
 * the OTEL context is available throughout the request lifecycle.
 */
const SKIP_TRACE_PATHS = new Set(["/healthz", "/readyz"]);

export const traceContextMiddleware: MiddlewareHandler = async (c, next) => {
    if (SKIP_TRACE_PATHS.has(c.req.path)) {
        return next();
    }

    const carrier: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
        carrier[key] = value;
    });

    const parentCtx = propagation.extract(context.active(), carrier);

    const span = tracer.startSpan(
        `${c.req.method} ${c.req.path}`,
        {
            kind: SpanKind.SERVER,
            attributes: {
                "http.method": c.req.method,
                "http.target": c.req.path,
            },
        },
        parentCtx,
    );

    const spanCtx = trace.setSpan(parentCtx, span);

    try {
        await context.with(spanCtx, () => next());
        span.setAttribute("http.status_code", c.res.status);
    } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (err instanceof Error) {
            span.recordException(err);
        }
        throw err;
    } finally {
        span.end();
    }
};
