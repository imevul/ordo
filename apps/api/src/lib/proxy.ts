import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Outbound HTTP proxies from the usual environment variables: HTTPS_PROXY / HTTP_PROXY (or
 * lowercase, or ALL_PROXY as a fallback) and NO_PROXY. Loopback never goes through a proxy.
 * Read at call time, so tests (and nothing else) can change them while running.
 */

const LOOPBACK = 'localhost,127.0.0.1,::1';

const pick = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
};

export function proxySettings() {
  return {
    httpsProxy: pick('https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'),
    httpProxy: pick('http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'),
    noProxy: [pick('no_proxy', 'NO_PROXY'), LOOPBACK].filter(Boolean).join(','),
  };
}

/**
 * Whether NO_PROXY exempts `url`. Entries are hosts or domains (`example.com` and `.example.com`
 * both cover subdomains), optionally with a port, or `*` for everything.
 */
export function bypassesProxy(url: URL, noProxy: string) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    // "[::1]:8080", "host:8080", or a bare IPv6 address (several colons, no port).
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry) ?? /^([^:]+):(\d+)$/.exec(entry);
    const name = (m ? m[1]! : entry).replace(/^\*?\./, '');
    if (m?.[2] && m[2] !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** The proxy URL to use for `url`, or null to connect directly. */
export function proxyFor(url: URL): string | null {
  const s = proxySettings();
  const proxy = url.protocol === 'https:' ? s.httpsProxy : s.httpProxy;
  if (!proxy || bypassesProxy(url, s.noProxy)) return null;
  return proxy;
}

const agents = new Map<string, ProxyAgent>();

/** CONNECT tunnels for https targets; plain forwarding for http ones (proxies often refuse CONNECT to port 80). */
export function proxyAgent(proxy: string) {
  let agent = agents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxy, proxyTunnel: false });
    agents.set(proxy, agent);
  }
  return agent;
}

/**
 * Sends everything that uses the global dispatcher (plain `fetch`, WebSockets) through the
 * configured proxy. `safeFetch` picks its own route, see there. Returns the proxy, for the log.
 */
export function useProxyFromEnv() {
  const s = proxySettings();
  if (!s.httpsProxy && !s.httpProxy) return null;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: s.httpProxy ?? undefined,
      httpsProxy: s.httpsProxy ?? undefined,
      noProxy: s.noProxy,
    }),
  );
  return redact(s.httpsProxy ?? s.httpProxy!);
}

/** "http://user:secret@proxy:3128" → "http://proxy:3128" */
export function redact(proxy: string) {
  try {
    const u = new URL(proxy);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return 'an unparseable proxy URL';
  }
}
