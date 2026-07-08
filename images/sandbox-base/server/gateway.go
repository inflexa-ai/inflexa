package main

// The gateway is the sandbox's only door.
//
// A sandbox container is attached to a Docker network created with `--internal`,
// which removes every route off its own bridge: no internet, no LAN, no
// `host.docker.internal`. That also removes published ports, so the host cannot
// reach the sandbox either — `--internal` is not an egress filter, it is a total
// disconnection. The gateway is what re-supplies the two directions the exec
// protocol actually needs, each as a single fixed-destination TCP hop:
//
//	host        --(published loopback port)-->  gateway :inbound  --> sandbox:8765
//	sandbox     --(CORTEX_BASE_URL)-------->    gateway :outbound --> Cortex ingress
//
// Nothing else is reachable. The gateway runs the same sandbox-base image (it is
// already pulled) but none of the exec machinery, and — deliberately — it is
// never handed SANDBOX_CALLBACK_SECRET. It forwards bytes; it cannot mint a
// signature, and a compromised gateway can therefore delay or drop a completion
// but not forge one. The signing key stays with the process being observed's
// supervisor, never with the transport.
//
// There is no gateway health endpoint on purpose. The harness probes the
// sandbox's own `/health` *through* the inbound leg, so a passing probe proves
// the whole ingress chain, not merely that a forwarder is listening.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	envGatewayInboundPort    = "GATEWAY_INBOUND_PORT"
	envGatewayInboundTarget  = "GATEWAY_INBOUND_TARGET"
	envGatewayOutboundPort   = "GATEWAY_OUTBOUND_PORT"
	envGatewayOutboundTarget = "GATEWAY_OUTBOUND_TARGET"

	defaultGatewayInboundPort  = "8765"
	defaultGatewayOutboundPort = "8766"

	gatewayDialTimeout = 10 * time.Second
)

type gatewayLeg struct {
	name   string
	listen string
	target string
}

type gatewayConfig struct {
	inbound  gatewayLeg
	outbound gatewayLeg
}

func loadGatewayConfig() gatewayConfig {
	return gatewayConfig{
		inbound: gatewayLeg{
			name:   "inbound",
			listen: "0.0.0.0:" + envOr(envGatewayInboundPort, defaultGatewayInboundPort),
			target: os.Getenv(envGatewayInboundTarget),
		},
		outbound: gatewayLeg{
			name:   "outbound",
			listen: "0.0.0.0:" + envOr(envGatewayOutboundPort, defaultGatewayOutboundPort),
			target: os.Getenv(envGatewayOutboundTarget),
		},
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func (c gatewayConfig) validate() error {
	if c.inbound.target == "" {
		return fmt.Errorf("%s is required", envGatewayInboundTarget)
	}
	if c.outbound.target == "" {
		return fmt.Errorf("%s is required", envGatewayOutboundTarget)
	}
	return nil
}

// runGateway serves both legs until SIGTERM/SIGINT. It returns the first
// listener error; a failure to bind either leg is fatal, because a gateway
// serving one direction is a sandbox that silently cannot report its results.
func runGateway(cfg gatewayConfig) error {
	if err := cfg.validate(); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		log.Printf("gateway: shutting down")
		cancel()
	}()

	log.Printf("gateway: %s -> %s | %s -> %s", cfg.inbound.listen, cfg.inbound.target, cfg.outbound.listen, cfg.outbound.target)

	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, leg := range []gatewayLeg{cfg.inbound, cfg.outbound} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := serveLeg(ctx, leg); err != nil {
				errs <- err
				cancel()
			}
		}()
	}
	wg.Wait()
	close(errs)
	return <-errs
}

// serveLeg binds leg.listen and pipes every accepted connection to leg.target.
func serveLeg(ctx context.Context, leg gatewayLeg) error {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", leg.listen)
	if err != nil {
		return fmt.Errorf("%s: listen %s: %w", leg.name, leg.listen, err)
	}
	return acceptLoop(ctx, ln, leg)
}

// acceptLoop is serveLeg minus the bind, so a test can supply its own listener
// and learn the ephemeral port it landed on.
func acceptLoop(ctx context.Context, ln net.Listener, leg gatewayLeg) error {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var conns sync.WaitGroup
	defer conns.Wait()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// A single failed Accept (fd exhaustion, a peer that vanished during
			// the handshake) must not take the leg down — the next call usually
			// succeeds, and a dead leg is unrecoverable for the sandbox.
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			log.Printf("gateway[%s]: accept: %v", leg.name, err)
			continue
		}
		conns.Add(1)
		go func() {
			defer conns.Done()
			pipe(leg, conn)
		}()
	}
}

// pipe splices one accepted connection to a fresh dial of leg.target.
//
// Each direction is closed for writing as soon as its source reaches EOF, so an
// HTTP peer that signals end-of-request by half-closing sees the upstream
// respond rather than hanging. Closing the whole socket on first EOF would
// truncate the response.
func pipe(leg gatewayLeg, client net.Conn) {
	defer func() { _ = client.Close() }()

	upstream, err := net.DialTimeout("tcp", leg.target, gatewayDialTimeout)
	if err != nil {
		log.Printf("gateway[%s]: dial %s: %v", leg.name, leg.target, err)
		return
	}
	defer func() { _ = upstream.Close() }()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstream, client)
		closeWrite(upstream)
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(client, upstream)
		closeWrite(client)
	}()
	wg.Wait()
}

// closeWrite half-closes a TCP connection, signalling EOF to the peer while the
// other direction keeps flowing.
func closeWrite(c net.Conn) {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.CloseWrite()
	}
}
