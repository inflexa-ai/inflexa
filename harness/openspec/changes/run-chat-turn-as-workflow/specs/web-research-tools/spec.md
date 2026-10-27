## ADDED Requirements

### Requirement: `web_fetch` reads one URL and refuses an internal address

The harness MUST give a `web_fetch` tool that reads one URL. The tool MUST accept only the `http:` and `https:` schemes, and it MUST refuse each other scheme as a normal result.

The tool MUST classify each address that the connection uses as guarded: loopback, private, link-local, shared, multicast, and reserved ranges, IPv4 and IPv6. The check MUST run on the address that the connection uses, not on a separate name resolution. Thus a name that resolves differently between the check and the connection (DNS rebinding) cannot pass the guard. For an IP literal, the tool MUST classify the literal before it sends the request. For a host name, the check MUST run in the lookup of the connection. It MUST classify each address that the resolver gives before the connect.

The tool MUST refuse a guarded address as a normal result, with no ask, and it MUST NOT connect to it. The refusal MUST name the origin. A refused URL and an HTTP error MUST be normal results, never a failure of the turn.

#### Scenario: A public URL is fetched without a prompt

- **WHEN** the model calls `web_fetch` on a public `https:` URL
- **THEN** the tool fetches it with no approval prompt

#### Scenario: A guarded address is refused with no ask

- **WHEN** the model calls `web_fetch` on `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`, or `[::ffff:169.254.169.254]`, or on a name that resolves to a guarded address
- **THEN** the tool refuses the address as a normal result, it asks nothing, and it connects to no guarded address

#### Scenario: A resolution with one guarded address is guarded

- **WHEN** a host name resolves to a public address and a guarded address
- **THEN** the tool refuses the hop before any connect, because the check classified both addresses of the resolution

#### Scenario: The scheme is checked

- **WHEN** the model calls `web_fetch` on a `file:` or `ftp:` URL
- **THEN** the tool refuses the URL as a normal result

### Requirement: `web_fetch` follows redirects under the guard of each hop

The tool MUST follow a maximum of 5 redirects, in the tool code. For each redirect target, the tool MUST do the whole sequence of a hop again: the scheme check and the guarded-address check. A redirect to a guarded address MUST end as a refusal, with no ask. A chain that needs a sixth redirect MUST end as a normal result that names the redirect limit.

#### Scenario: A redirect to a guarded address is refused

- **WHEN** a public URL redirects to `127.0.0.1` or to another guarded address
- **THEN** the tool refuses the redirect as a normal result, and it does not follow it

#### Scenario: Five redirects succeed, the sixth is refused

- **WHEN** a URL redirects 5 times to a public address, or 6 times
- **THEN** the tool follows a maximum of 5 redirects, and a chain that needs a sixth ends as a normal result that names the redirect limit

## REMOVED Requirements

### Requirement: `web_fetch` reads one URL under a guarded-address approval

**Reason**: A tool call of a turn workflow asks before it runs, and a fetch learns the address of a name only in its connect. The tool refuses an internal address with no ask (decision Q9).

**Migration**: Refer to "`web_fetch` reads one URL and refuses an internal address".

### Requirement: `web_fetch` follows redirects under the same guard

**Reason**: A redirect to a guarded address is refused, with no ask.

**Migration**: Refer to "`web_fetch` follows redirects under the guard of each hop".
