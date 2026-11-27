import { BlockList, isIP } from 'node:net';

function subnets(family: 'ipv4' | 'ipv6', entries: [string, number][]) {
  const result = new BlockList();
  for (const [network, prefix] of entries) {
    result.addSubnet(network, prefix, family);
  }
  return result;
}

const localV4Entries: [string, number][] = [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];
const localV4 = subnets('ipv4', localV4Entries);
const nonPublicV4 = subnets('ipv4', [
  ...localV4Entries,
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);
const mappedV4 = subnets('ipv6', [['::ffff:0:0', 96]]);
const localV6 = subnets('ipv6', [
  ['::1', 128],
  ['fc00::', 7],
]);
const metadataV6 = subnets('ipv6', [
  ['fd00:ec2::254', 128],
  ['fd20:ce::254', 128],
]);
const globalV6 = subnets('ipv6', [['2000::', 3]]);
const reservedV6 = subnets('ipv6', [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]);

export function isAllowedProviderAddress(address: string, local: boolean) {
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  if (family === 4 || mappedV4.check(address, 'ipv6')) {
    // BlockList applies IPv4 subnets to IPv4-mapped IPv6 addresses too.
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (local && localV4.check(address, type)) return true;
    return !nonPublicV4.check(address, type);
  }
  if (local && localV6.check(address, 'ipv6'))
    return !metadataV6.check(address, 'ipv6');
  // This also excludes link-local, multicast, and deprecated IPv4-compatible IPv6.
  return globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');
}
