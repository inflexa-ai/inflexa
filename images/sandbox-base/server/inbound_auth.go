package main

// Inbound requests are authenticated the same way outbound callbacks are —
// by signature, not by a shared bearer token.
//
// The distinction is load-bearing under the gateway topology. The gateway
// forwards these bytes in cleartext, so any static credential sent inbound
// (an `Authorization: Bearer <secret>` header, say) would be exposed to it,
// handing the transport the very key it must never hold. A signature is not a
// reusable credential: the gateway sees it, cannot mint another, and so keeps
// the property that it can forward or drop a request but never forge one.
//
// The construction is identical to the callbacks, run in the opposite
// direction: the harness signs `HMAC-SHA256(callbackSecret,
// "${execId}:${timestamp}:${sha256Hex(body)}")` and this server verifies it
// against a freshness window. Because possession of the per-sandbox secret is
// what the check tests, it also confines lateral movement: a sibling sandbox on
// the shared analysis network cannot drive this one's `/exec`, holding only its
// own secret, not this one's.

import (
	"crypto/hmac"
	"net/http"
	"strconv"
	"time"
)

// inboundFreshnessSeconds bounds how long a signed request stays acceptable.
// It mirrors the callback freshness window. Replay inside it is harmless: the
// signed endpoints (`/exec` submit, `/exec/{execId}` result) are idempotent.
const inboundFreshnessSeconds = 300

// inboundAuth verifies request signatures against the per-sandbox secret.
type inboundAuth struct {
	secret []byte
	now    func() time.Time
}

func newInboundAuth(secret []byte) inboundAuth {
	return inboundAuth{secret: secret, now: time.Now}
}

// authentic reports whether r carries a fresh, correctly-signed
// `X-Sandbox-Signature` / `X-Sandbox-Timestamp` pair for (execID, body).
// `body` is the exact bytes the request carried — the empty slice for a GET.
func (a inboundAuth) authentic(r *http.Request, execID string, body []byte) bool {
	sig := r.Header.Get(headerSignature)
	tsStr := r.Header.Get(headerTimestamp)
	if sig == "" || tsStr == "" {
		return false
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return false
	}
	if drift := a.now().Unix() - ts; drift > inboundFreshnessSeconds || drift < -inboundFreshnessSeconds {
		return false
	}
	want := signCallback(a.secret, execID, ts, body)
	// hmac.Equal is constant-time and safe on unequal-length inputs.
	return hmac.Equal([]byte(sig), []byte(want))
}

// writeUnauthorized emits the 401 an unauthenticated inbound request receives.
// The body is deliberately terse: an unauthenticated caller learns only that a
// signature was required, not why theirs failed.
func writeUnauthorized(w http.ResponseWriter) {
	writeJSONResponse(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}
