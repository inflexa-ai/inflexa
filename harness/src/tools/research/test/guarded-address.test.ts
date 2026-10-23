/**
 * The classification table of the guarded-address classifier.
 *
 * One row per pinned range: an address inside it, and the first and the last
 * address of the range. Between two ranges, the address just outside each edge
 * stays unguarded — an off-by-one in a CIDR span shows here, not on a host.
 * The IPv4-mapped form classifies through its IPv4 half, thus a public mapped
 * address stays unguarded and a private one is guarded.
 */

import { describe, expect, it } from "bun:test";

import { isGuardedAddress } from "../guarded-address.js";

const GUARDED = [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:0.0.0.0",
];

const UNGUARDED = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "::2"];

/** The first and the last address of each range of the pinned table. */
const RANGE_EDGES: readonly [first: string, last: string][] = [
    ["0.0.0.0", "0.255.255.255"],
    ["10.0.0.0", "10.255.255.255"],
    ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"],
    ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"],
    ["192.0.2.0", "192.0.2.255"],
    ["192.88.99.0", "192.88.99.255"],
    ["192.168.0.0", "192.168.255.255"],
    ["198.18.0.0", "198.19.255.255"],
    ["198.51.100.0", "198.51.100.255"],
    ["203.0.113.0", "203.0.113.255"],
    ["224.0.0.0", "239.255.255.255"],
    ["240.0.0.0", "255.255.255.255"],
    ["::", "::"],
    ["::1", "::1"],
    ["64:ff9b::", "64:ff9b::ffff:ffff"],
    ["64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
    ["100::", "100::ffff:ffff:ffff:ffff"],
    ["2001::", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
];

/** Addresses one step outside a range edge, none of them inside another range of the table. */
const OUTSIDE_EDGES = [
    "1.0.0.0", // above 0.0.0.0/8
    "9.255.255.255", // below 10.0.0.0/8
    "11.0.0.0", // above 10.0.0.0/8
    "100.63.255.255", // below 100.64.0.0/10
    "100.128.0.0", // above 100.64.0.0/10
    "126.255.255.255", // below 127.0.0.0/8
    "128.0.0.0", // above 127.0.0.0/8
    "169.253.255.255", // below 169.254.0.0/16
    "169.255.0.0", // above 169.254.0.0/16
    "172.15.255.255", // below 172.16.0.0/12
    "172.32.0.0", // above 172.16.0.0/12
    "192.0.1.0", // the gap between 192.0.0.0/24 and 192.0.2.0/24
    "192.0.3.0", // above 192.0.2.0/24
    "192.88.98.255", // below 192.88.99.0/24
    "192.88.100.0", // above 192.88.99.0/24
    "192.167.255.255", // below 192.168.0.0/16
    "192.169.0.0", // above 192.168.0.0/16
    "198.17.255.255", // below 198.18.0.0/15
    "198.20.0.0", // above 198.18.0.0/15
    "198.51.99.255", // below 198.51.100.0/24
    "198.51.101.0", // above 198.51.100.0/24
    "203.0.112.255", // below 203.0.113.0/24
    "203.0.114.0", // above 203.0.113.0/24
    "223.255.255.255", // below 224.0.0.0/4
    "::2", // above ::1/128
    "64:ff9b:0:0:0:1::", // above 64:ff9b::/96
    "64:ff9b:2::", // above 64:ff9b:1::/48
    "100:0:0:1::", // above 100::/64
    "2001:1::", // above 2001::/32
    "2001:db9::", // above 2001:db8::/32
    "2003::", // above 2002::/16
    "fe00::", // above fc00::/7
    "fec0::", // above fe80::/10
];

describe("isGuardedAddress", () => {
    it.each(GUARDED)("guards %s", (ip) => {
        expect(isGuardedAddress(ip)).toBe(true);
    });

    it.each(UNGUARDED)("does not guard %s", (ip) => {
        expect(isGuardedAddress(ip)).toBe(false);
    });

    it.each(RANGE_EDGES)("guards the range edges %s and %s", (first, last) => {
        expect(isGuardedAddress(first)).toBe(true);
        expect(isGuardedAddress(last)).toBe(true);
    });

    it.each(OUTSIDE_EDGES)("does not guard %s, which sits one step outside a range", (ip) => {
        expect(isGuardedAddress(ip)).toBe(false);
    });

    it.each(["FF02::1", "::FFFF:10.0.0.1", "FE80::1"])("classifies the uppercase form %s", (ip) => {
        expect(isGuardedAddress(ip)).toBe(true);
    });

    it.each(["example.com", "not-an-ip", "", "999.1.1.1", "192.168.1"])("gives false for %s, which is no IP address", (value) => {
        expect(isGuardedAddress(value)).toBe(false);
    });
});
