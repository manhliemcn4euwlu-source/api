// node --test  (run from api/). isPrivate() decides which addresses a paid /v1/fetch may reach. It is a parsed
// classifier since 2026-09-28: the textual prefix regex before it missed fe80::/10 beyond the literal "fe80", the
// unspecified "::" and IPv4-mapped 169.254/16 (Ops Control HQ, 2026-09-28). Unparseable input is refused.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./guard-data');   // every write under data/ is dropped before the server boots (counters, ledgers, logs)
const { isPrivate, expand6 } = require('../server');

const PRIVATE = ['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1', '224.0.0.1',
  '::1', '::', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fec0::1', 'fd00::1', 'fc00::1', 'ff02::1',
  '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip'];
const PUBLIC = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::'];

test('private, loopback, link-local, mapped, NAT64, 6to4 and unparseable addresses are refused', () => {
  for (const ip of PRIVATE) assert.equal(isPrivate(ip), true, ip);
});
test('public unicast addresses, plain and embedded, are allowed', () => {
  for (const ip of PUBLIC) assert.equal(isPrivate(ip), false, ip);
});
// One address at each end of every range the IANA IPv4 and IPv6 special-purpose registries mark not globally reachable
// (the IPv4 list was already complete; the IPv6 ranges 64:ff9b:1::/48, 2001:2::/48, 2001:10::/28, 3fff::/20 and 5f00::/16
// were added 2026-09-29), with the first address past each IPv4 range as a public control (Ops Control HQ, 2026-09-28 22:26
// and 22:32 UTC; ranges from the IANA special-purpose registries). 2001:20::/28 (ORCHIDv2) was refused for a few hours on
// 2026-09-29 and is allowed again: its registry row says globally reachable (jcemus, 2026-09-29).
const REGISTRY_V4 = ['0.1.2.3', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.0', '127.255.255.255',
  '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255', '192.0.0.0', '192.0.0.170', '192.0.0.255', '192.0.2.0', '192.0.2.255',
  '192.168.0.0', '192.168.255.255', '198.18.0.0', '198.19.255.255', '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255',
  '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.254', '255.255.255.255'];
const REGISTRY_V6 = ['64:ff9b:1::', '64:ff9b:1::1', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '2001:2::', '2001:2::1', '2001:2:0:ffff:ffff:ffff:ffff:ffff',
  '2001:10::', '2001:10::1', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff',
  '3fff::', '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '5f00::', '5f00::1', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
const PAST_V4 = ['1.0.0.0', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0',
  '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0',
  '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255'];
test('every non-globally-reachable range of the IANA IPv4 and IPv6 special-purpose registries is refused', () => {
  for (const ip of [...REGISTRY_V4, ...REGISTRY_V6]) assert.equal(isPrivate(ip), true, ip);
});
test('the address on either side of each IPv4 range, public IPv6 unicast and ORCHIDv2 are allowed', () => {
  for (const ip of [...PAST_V4, '1.1.1.1', '8.8.8.8', '2606:4700::1111', '2606:4700:4700::1111', '2001:4860:4860::8888', '2001:20::1', '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff']) assert.equal(isPrivate(ip), false, ip);
});
test('expand6 gives eight hextets, folding :: and a dotted IPv4 tail, or null', () => {
  assert.deepEqual(expand6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(expand6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expand6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepEqual(expand6('::1.2.3.4'), [0, 0, 0, 0, 0, 0, 0x0102, 0x0304]);
  assert.deepEqual(expand6('64:ff9b::1.2.3.4'), [0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
  assert.deepEqual(expand6('fe90::1'), [0xfe90, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expand6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(expand6('2002:7f00:1::'), [0x2002, 0x7f00, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(expand6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  for (const bad of ['1:2:3', '1:2:3:4:5:6:7:8:9', '::1::2', 'zz::1', '::ffff:1.2.3.999', '']) assert.equal(expand6(bad), null, bad);
});
