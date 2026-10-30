import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { proxyAgent, proxyFor } from './proxy.ts';

/**
 * Outbound HTTP for URLs that admins type in (IdP issuers, forge and chat base URLs, webhooks).
 * Blocks loopback/private/link-local targets unless allowed, checks every redirect hop, and
 * validates the address at connect time, so DNS rebinding can't slip past the check. Honours
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY (see `proxy.ts`).
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) inherits the IPv4 verdict.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

export class BlockedTargetError extends Error {
  constructor(host: string) {
    super(
      `Refusing to connect to private address for ${host}. An instance admin can allow private network targets.`,
    );
  }
}

const agents = new Map<boolean, Agent>();

function agentFor(allowPrivate: boolean): Agent {
  let agent = agents.get(allowPrivate);
  if (!agent) {
    agent = new Agent({
      connect: {
        lookup(hostname, options, callback) {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err, '', 0);
            const list = addresses as LookupAddress[];
            const ok = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
            if (ok.length === 0) return callback(new BlockedTargetError(hostname), '', 0);
            if ((options as { all?: boolean }).all)
              return (callback as (e: null, a: LookupAddress[]) => void)(null, ok);
            callback(null, ok[0]!.address, ok[0]!.family);
          });
        },
      },
    });
    agents.set(allowPrivate, agent);
  }
  return agent;
}

/** Every address `host` resolves to must be public. Fails closed when it can't be resolved. */
async function assertPublicHost(host: string) {
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookupAll(host, { all: true });
  } catch (err) {
    throw new Error(
      `Couldn't resolve ${host} to check it before going through the proxy (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). An instance admin can allow private network targets to skip this check.`,
    );
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new BlockedTargetError(host);
}

/** Credentials the fetch spec drops when a redirect leaves the origin they were meant for. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
/** Describe the body, so they go when a redirect turns the request into a bodiless GET. */
const BODY_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
]);

function withoutHeaders(headers: Record<string, string>, names: Set<string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())),
  );
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Cancels the request early (a long poll when its connection is stopped). */
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const {
    allowPrivate = false,
    timeoutMs = 10_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5,
  } = opts;
  const signal = opts.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
    : AbortSignal.timeout(timeoutMs);
  let url = new URL(input);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  let headers = opts.headers ?? {};

  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error(`Unsupported protocol ${url.protocol}`);
    // Literal IPs never go through DNS, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) throw new BlockedTargetError(host);

    // Through a proxy the proxy connects, so the address can't be checked at connect time:
    // check it beforehand instead (a DNS answer that changes in between can still slip through).
    const proxy = proxyFor(url);
    if (proxy && !allowPrivate && !isIP(host)) await assertPublicHost(host);

    const res = await undiciFetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal,
      dispatcher: proxy ? proxyAgent(proxy) : agentFor(allowPrivate),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new Error('Too many redirects');
      const next = new URL(res.headers.get('location')!, url);
      // A token for one host must not reach another, even when the first one sends us there.
      if (next.origin !== url.origin) headers = withoutHeaders(headers, CREDENTIAL_HEADERS);
      url = next;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = withoutHeaders(headers, BODY_HEADERS);
      }
      continue;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          await res.body.cancel().catch(() => {});
          throw new Error(`Response larger than ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    }
    const buf = Buffer.concat(chunks);
    return {
      status: res.status,
      ok: res.ok,
      url: url.toString(),
      headers: res.headers as unknown as Headers,
      body: buf,
      text: () => buf.toString('utf8'),
      json: <T>() => JSON.parse(buf.toString('utf8')) as T,
    };
  }
}
