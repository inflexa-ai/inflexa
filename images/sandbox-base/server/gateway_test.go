package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// startLeg runs an acceptLoop on an ephemeral port and returns its address.
func startLeg(t *testing.T, target string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = acceptLoop(ctx, ln, gatewayLeg{name: "test", listen: ln.Addr().String(), target: target})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return ln.Addr().String()
}

func TestGatewayConfig_RequiresBothTargets(t *testing.T) {
	base := gatewayConfig{
		inbound:  gatewayLeg{name: "inbound", listen: "0.0.0.0:8765", target: "sbx:8765"},
		outbound: gatewayLeg{name: "outbound", listen: "0.0.0.0:8766", target: "host.docker.internal:1234"},
	}
	if err := base.validate(); err != nil {
		t.Fatalf("expected a fully-configured gateway to validate, got %v", err)
	}

	noIn := base
	noIn.inbound.target = ""
	if err := noIn.validate(); err == nil || !strings.Contains(err.Error(), envGatewayInboundTarget) {
		t.Fatalf("expected missing inbound target to be rejected, got %v", err)
	}

	// A gateway that serves only the inbound leg is a sandbox that can be driven
	// but can never report — worse than one that fails to start.
	noOut := base
	noOut.outbound.target = ""
	if err := noOut.validate(); err == nil || !strings.Contains(err.Error(), envGatewayOutboundTarget) {
		t.Fatalf("expected missing outbound target to be rejected, got %v", err)
	}
}

// The gateway must be transparent to HTTP in both directions: a request body
// reaches the upstream and the full response comes back. Half-close handling is
// what makes this work — closing the socket on the first EOF would truncate the
// response.
func TestGateway_ForwardsHTTPRequestAndResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/exec" {
			t.Errorf("path not preserved: %s", r.URL.Path)
		}
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintf(w, "saw:%s", body)
	}))
	defer upstream.Close()

	addr := startLeg(t, strings.TrimPrefix(upstream.URL, "http://"))

	res, err := http.Post("http://"+addr+"/exec", "application/json", strings.NewReader(`{"execId":"x1"}`))
	if err != nil {
		t.Fatalf("post through gateway: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("status not forwarded: got %d", res.StatusCode)
	}
	if res.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("response headers not forwarded")
	}
	got, _ := io.ReadAll(res.Body)
	if string(got) != `saw:{"execId":"x1"}` {
		t.Fatalf("body not forwarded intact: %q", got)
	}
}

// Keep-alive connections carry several requests over one pipe; the forwarder
// must not assume one connection is one exchange.
func TestGateway_ForwardsSequentialRequestsOnOneConnection(t *testing.T) {
	var seen int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		seen++
		fmt.Fprintf(w, "n=%d", seen)
	}))
	defer upstream.Close()

	addr := startLeg(t, strings.TrimPrefix(upstream.URL, "http://"))
	client := &http.Client{Timeout: 5 * time.Second}

	for i := 1; i <= 3; i++ {
		res, err := client.Get("http://" + addr + "/health")
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if want := fmt.Sprintf("n=%d", i); string(body) != want {
			t.Fatalf("request %d: got %q want %q", i, body, want)
		}
	}
}

// A sandbox that is not up yet must not wedge the caller: the gateway closes the
// connection so the client sees a clean failure and can retry.
func TestGateway_ClosesConnectionWhenTargetIsUnreachable(t *testing.T) {
	// Port 1 on loopback refuses immediately.
	addr := startLeg(t, "127.0.0.1:1")

	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	defer func() { _ = conn.Close() }()

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	if _, err := conn.Read(buf); err != io.EOF {
		t.Fatalf("expected EOF from a gateway whose target refused, got %v", err)
	}
}

// The gateway is the sandbox's only door, so it must be the one component that
// cannot forge a completion. It never reads the callback secret.
func TestGateway_DoesNotReadTheCallbackSecret(t *testing.T) {
	t.Setenv(envCallbackSecret, "super-secret")
	t.Setenv(envGatewayInboundTarget, "sbx:8765")
	t.Setenv(envGatewayOutboundTarget, "host.docker.internal:1234")

	cfg := loadGatewayConfig()
	if err := cfg.validate(); err != nil {
		t.Fatalf("expected valid config, got %v", err)
	}

	rendered := fmt.Sprintf("%+v", cfg)
	if strings.Contains(rendered, "super-secret") {
		t.Fatalf("gateway config captured the callback secret: %s", rendered)
	}
}

func TestGatewayConfig_DefaultsPorts(t *testing.T) {
	t.Setenv(envGatewayInboundTarget, "sbx:8765")
	t.Setenv(envGatewayOutboundTarget, "host.docker.internal:1234")

	cfg := loadGatewayConfig()
	if cfg.inbound.listen != "0.0.0.0:"+defaultGatewayInboundPort {
		t.Fatalf("inbound listen default: %s", cfg.inbound.listen)
	}
	if cfg.outbound.listen != "0.0.0.0:"+defaultGatewayOutboundPort {
		t.Fatalf("outbound listen default: %s", cfg.outbound.listen)
	}

	t.Setenv(envGatewayInboundPort, "9001")
	if cfg := loadGatewayConfig(); cfg.inbound.listen != "0.0.0.0:9001" {
		t.Fatalf("inbound port override ignored: %s", cfg.inbound.listen)
	}
}
