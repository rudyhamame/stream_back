import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag',
  'last-modified', 'cache-control', 'expires', 'content-encoding', 'vary',
];
const REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const normalizedHostname = value => String(value || '').replace(/^\[|\]$/g, '').toLowerCase();

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function inV4(address, network, bits) {
  const ip = ipv4Number(address); const base = ipv4Number(network);
  if (ip === null || base === null) return false;
  const shift = BigInt(32 - bits);
  return (ip >> shift) === (base >> shift);
}

function ipv6Number(address) {
  let source = String(address).toLowerCase().split('%')[0];
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    const v4 = ipv4Number(source.slice(lastColon + 1));
    if (v4 === null) return null;
    source = `${source.slice(0, lastColon)}:${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inV6(address, network, bits) {
  const ip = ipv6Number(address); const base = ipv6Number(network);
  if (ip === null || base === null) return false;
  const shift = BigInt(128 - bits);
  return (ip >> shift) === (base >> shift);
}

export function isPublicAddress(address) {
  const family = net.isIP(String(address).split('%')[0]);
  if (family === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, bits]) => inV4(address, network, bits));
  }
  if (family !== 6) return false;
  const normalized = String(address).split('%')[0].toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIP(mapped) === 4) return isPublicAddress(mapped);
    const mappedValue = ipv6Number(normalized);
    if (mappedValue === null) return false;
    const v4 = Number(mappedValue & 0xffffffffn);
    const decoded = [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.');
    return isPublicAddress(decoded);
  }
  // Globally reachable unicast space is 2000::/3. Exclude documentation,
  // benchmarking, ORCHID, and protocol-assignment blocks within that range.
  return inV6(normalized, '2000::', 3)
    && !inV6(normalized, '2001:db8::', 32)
    && !inV6(normalized, '2001:2::', 48)
    && !inV6(normalized, '2001:10::', 28);
}

export function validateMediaUrl(value, allowPrivateHosts = new Set()) {
  let target;
  try { target = new URL(value); } catch { throw new Error('invalid media URL'); }
  const hostname = normalizedHostname(target.hostname);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('unsupported media URL');
  }
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    if (allowPrivateHosts.has(hostname)) return target;
    throw new Error('private media destination');
  }
  if (net.isIP(hostname) && !isPublicAddress(hostname) && !allowPrivateHosts.has(hostname)) throw new Error('private media destination');
  return target;
}

async function resolvePublic(hostname, allowPrivateHosts) {
  hostname = normalizedHostname(hostname);
  if (allowPrivateHosts.has(hostname.toLowerCase())) {
    const rows = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!rows.length) throw new Error('provider DNS lookup failed');
    return rows;
  }
  const rows = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) throw new Error('private media destination');
  return rows;
}

async function resolveWithTimeout(hostname, allowPrivateHosts, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      resolvePublic(hostname, allowPrivateHosts),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('upstream DNS timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function requestOnce(url, method, headers, addresses, { connectTimeoutMs, firstByteTimeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const address = addresses[0];
    let settled = false;
    let connectTimer;
    let firstByteTimer;
    const finishError = error => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer); clearTimeout(firstByteTimer);
      reject(error);
    };
    const req = transport.request({
      protocol: url.protocol,
      hostname: normalizedHostname(url.hostname),
      port: url.port || undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      auth: url.username || url.password ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
      servername: net.isIP(normalizedHostname(url.hostname)) ? undefined : normalizedHostname(url.hostname),
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, response => {
      clearTimeout(firstByteTimer);
      if (settled) { response.destroy(); return; }
      settled = true;
      clearTimeout(connectTimer);
      resolve({ response, req });
    });
    const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('client disconnected'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    req.once('error', finishError);
    req.on('socket', socket => {
      const established = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      if (socket.connecting || (url.protocol === 'https:' && !socket.encrypted)) {
        connectTimer = setTimeout(() => req.destroy(new Error('upstream connection timeout')), connectTimeoutMs);
        connectTimer.unref?.();
        socket.once(established, () => clearTimeout(connectTimer));
      }
    });
    firstByteTimer = setTimeout(() => req.destroy(new Error('upstream first byte timeout')), firstByteTimeoutMs);
    firstByteTimer.unref?.();
    req.end();
  });
}

export async function openProviderMedia({ url, method = 'GET', requestHeaders = {}, allowedRedirectHosts = [], signal, connectTimeoutMs = 10_000, firstByteTimeoutMs = 25_000, idleTimeoutMs = 45_000, maxRedirects = 5, allowPrivateHosts = [] }) {
  const allowedHosts = new Set(allowedRedirectHosts.map(normalizedHostname));
  const privateHosts = new Set(allowPrivateHosts.map(host => String(host).toLowerCase()));
  let target = validateMediaUrl(url, privateHosts);
  const originHost = normalizedHostname(target.hostname);
  allowedHosts.add(originHost);
  const headers = { 'user-agent': 'RH-Media-Proxy/1.0', 'accept-encoding': 'identity', connection: 'close' };
  for (const name of REQUEST_HEADERS) if (requestHeaders[name]) headers[name] = requestHeaders[name];

  for (let redirects = 0; ; redirects += 1) {
    if (!allowedHosts.has(normalizedHostname(target.hostname))) throw new Error('provider redirect host is not allowed');
    const addresses = await resolveWithTimeout(target.hostname, privateHosts, connectTimeoutMs);
    const { response } = await requestOnce(target, method, headers, addresses, { connectTimeoutMs, firstByteTimeoutMs, signal });
    response.socket?.setTimeout(idleTimeoutMs, () => response.destroy(new Error('upstream idle timeout')));
    if (!REDIRECT_STATUSES.has(response.statusCode || 0)) return { response, url: target };
    const location = response.headers.location;
    response.destroy();
    if (!location || redirects >= maxRedirects) throw new Error('provider redirect limit exceeded');
    target = validateMediaUrl(new URL(location, target).href, privateHosts);
    if (!allowedHosts.has(normalizedHostname(target.hostname))) throw new Error('provider redirect host is not allowed');
  }
}

export function copyMediaHeaders(upstream, downstream) {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers[name];
    if (value != null) downstream.setHeader(name, value);
  }
}

export async function pipeProviderMedia(upstream, downstream) {
  await pipeline(upstream, downstream);
}
