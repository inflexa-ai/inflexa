/**
 * The guarded-address classifier of the web research tools.
 *
 * One pure function over one address: `isGuardedAddress` answers whether the
 * address falls in a range that `web_fetch` asks the user about before it
 * connects. The ranges are a pinned subset of the special-purpose address
 * ranges of the IANA registries — loopback, private, shared, link-local,
 * multicast, reserved, documentation, and benchmarking space, IPv4 and IPv6.
 * A public unicast address is never guarded.
 *
 * The caller owns the question "which address does the connection use": the
 * classifier never resolves a name and it never reads the network.
 */

import { isIP } from "node:net";

import { isAllDigits, isAllHex } from "../../lib/text.js";

/** Parse a dotted-quad IPv4 address into its 32-bit value. Anything else gives null. */
function ipv4ToNumber(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (part.length === 0 || part.length > 3 || !isAllDigits(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = (value << 8) | octet;
    }
    return value >>> 0;
}

/** Parse an IPv6 address into its 128-bit value. Anything else gives null. */
function ipv6ToBigInt(ip: string): bigint | null {
    let text = ip.toLowerCase();
    // An embedded IPv4 tail stands for its two low-order groups.
    if (text.includes(".")) {
        const lastColon = text.lastIndexOf(":");
        const tail = ipv4ToNumber(text.slice(lastColon + 1));
        if (tail === null) return null;
        const high = ((tail >>> 16) & 0xffff).toString(16);
        const low = (tail & 0xffff).toString(16);
        text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const groupsOf = (half: string): bigint[] | null => {
        if (half === "") return [];
        const groups: bigint[] = [];
        for (const group of half.split(":")) {
            if (group.length === 0 || group.length > 4 || !isAllHex(group)) return null;
            groups.push(BigInt(`0x${group}`));
        }
        return groups;
    };

    const halves = text.split("::");
    if (halves.length > 2) return null;
    const left = groupsOf(halves[0] ?? "");
    const right = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (halves.length === 2 ? fill < 0 : fill !== 0) return null;

    return [...left, ...new Array<bigint>(Math.max(fill, 0)).fill(0n), ...right].reduce((acc, group) => (acc << 16n) | group, 0n);
}

/** One pinned IPv4 range as an inclusive numeric span. */
type Ipv4Range = {
    readonly first: number;
    readonly last: number;
};

/** One pinned IPv6 range as an inclusive 128-bit span. */
type Ipv6Range = {
    readonly first: bigint;
    readonly last: bigint;
};

const ipv4Span = (first: string, last: string): Ipv4Range => {
    const low = ipv4ToNumber(first);
    const high = ipv4ToNumber(last);
    if (low === null || high === null) throw new Error(`Bad IPv4 range literal: ${first}..${last}`);
    return { first: low, last: high };
};

const ipv6Span = (first: string, last: string): Ipv6Range => {
    const low = ipv6ToBigInt(first);
    const high = ipv6ToBigInt(last);
    if (low === null || high === null) throw new Error(`Bad IPv6 range literal: ${first}..${last}`);
    return { first: low, last: high };
};

/**
 * The pinned IPv4 table. `240.0.0.0/4` holds the reserved and the broadcast
 * space together, and it ends at the top of the address family.
 */
const GUARDED_IPV4_RANGES: readonly Ipv4Range[] = [
    ipv4Span("0.0.0.0", "0.255.255.255"), // 0.0.0.0/8
    ipv4Span("10.0.0.0", "10.255.255.255"), // 10.0.0.0/8
    ipv4Span("100.64.0.0", "100.127.255.255"), // 100.64.0.0/10
    ipv4Span("127.0.0.0", "127.255.255.255"), // 127.0.0.0/8
    ipv4Span("169.254.0.0", "169.254.255.255"), // 169.254.0.0/16
    ipv4Span("172.16.0.0", "172.31.255.255"), // 172.16.0.0/12
    ipv4Span("192.0.0.0", "192.0.0.255"), // 192.0.0.0/24
    ipv4Span("192.0.2.0", "192.0.2.255"), // 192.0.2.0/24
    ipv4Span("192.88.99.0", "192.88.99.255"), // 192.88.99.0/24
    ipv4Span("192.168.0.0", "192.168.255.255"), // 192.168.0.0/16
    ipv4Span("198.18.0.0", "198.19.255.255"), // 198.18.0.0/15
    ipv4Span("198.51.100.0", "198.51.100.255"), // 198.51.100.0/24
    ipv4Span("203.0.113.0", "203.0.113.255"), // 203.0.113.0/24
    ipv4Span("224.0.0.0", "239.255.255.255"), // 224.0.0.0/4
    ipv4Span("240.0.0.0", "255.255.255.255"), // 240.0.0.0/4
];

/**
 * The pinned IPv6 table, without `::ffff:0:0/96`: an IPv4-mapped address
 * normalizes to its IPv4 half first, thus that range classifies through the
 * IPv4 table above.
 */
const GUARDED_IPV6_RANGES: readonly Ipv6Range[] = [
    ipv6Span("::", "::"), // ::/128
    ipv6Span("::1", "::1"), // ::1/128
    ipv6Span("64:ff9b::", "64:ff9b::ffff:ffff"), // 64:ff9b::/96
    ipv6Span("64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"), // 64:ff9b:1::/48
    ipv6Span("100::", "100::ffff:ffff:ffff:ffff"), // 100::/64
    ipv6Span("2001::", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff"), // 2001::/32
    ipv6Span("2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"), // 2001:db8::/32
    ipv6Span("2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), // 2002::/16
    ipv6Span("fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), // fc00::/7
    ipv6Span("fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), // fe80::/10
    ipv6Span("ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), // ff00::/8
];

function isGuardedIpv4(value: number): boolean {
    return GUARDED_IPV4_RANGES.some((range) => value >= range.first && value <= range.last);
}

function isGuardedIpv6(value: bigint): boolean {
    return GUARDED_IPV6_RANGES.some((range) => value >= range.first && value <= range.last);
}

/**
 * Is this address one the web tools guard? An IP literal of either family
 * classifies against the pinned table; the IPv4-mapped IPv6 form
 * (`::ffff:10.0.0.1`) classifies as its IPv4 half. A value that is not an IP
 * address gives false — the caller resolves names before it reaches here.
 */
export function isGuardedAddress(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) {
        const value = ipv4ToNumber(ip);
        return value !== null && isGuardedIpv4(value);
    }
    if (family === 6) {
        const value = ipv6ToBigInt(ip);
        if (value === null) return false;
        // The IPv4-mapped form, ::ffff:0:0/96, classifies as its IPv4 half.
        if (value >> 32n === 0xffffn) return isGuardedIpv4(Number(value & 0xffffffffn));
        return isGuardedIpv6(value);
    }
    return false;
}
