import { promises as dnsPromises } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { BodyTooLargeError, readLimitedText } from "./http.js";

/*
 * SSRF protection for fetching Client ID Metadata Documents: the client ID is a
 * URL chosen by an unauthenticated party, so the server must never be tricked
 * into calling internal addresses (cloud metadata services, container networks,
 * localhost admin ports).
 */

const PRIVATE_IPV4: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (carrier-grade NAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link local, cloud metadata services)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc0586300, 24], // 192.88.99.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xe0000000, 4], // 224.0.0.0/4 (multicast)
  [0xf0000000, 4], // 240.0.0.0/4 (reserved, includes broadcast)
];

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const s of parts) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const o = Number(s);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToNumber(ip);
  if (n === null) return true;
  return PRIVATE_IPV4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === base;
  });
}

function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4?.[1]) {
    const n = ipv4ToNumber(v4[1]);
    if (n === null) return null;
    s = `${s.slice(0, -v4[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  return groups.map((p) => parseInt(p, 16));
}

function isPrivateIpv6(ip: string): boolean {
  const h = ipv6Groups(ip);
  if (!h) return true;
  const g = (i: number) => h[i] ?? 0;
  const embedded = () => `${g(6) >> 8}.${g(6) & 0xff}.${g(7) >> 8}.${g(7) & 0xff}`;
  if (h.slice(0, 6).every((x) => x === 0)) return g(6) === 0 && g(7) <= 1 ? true : isPrivateIpv4(embedded()); // ::, ::1, ::a.b.c.d
  if (h.slice(0, 5).every((x) => x === 0) && g(5) === 0xffff) return isPrivateIpv4(embedded()); // ::ffff:a.b.c.d
  if (g(0) === 0x64 && g(1) === 0xff9b) return g(2) === 0 && h.slice(3, 6).every((x) => x === 0) ? isPrivateIpv4(embedded()) : true; // NAT64
  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g(0) & 0xffc0) === 0xfe80 || (g(0) & 0xffc0) === 0xfec0) return true; // link local, site local
  if ((g(0) & 0xff00) === 0xff00) return true; // multicast
  if (g(0) === 0x2001 && (g(1) === 0x0db8 || g(1) === 0)) return true; // documentation, Teredo
  if (g(0) === 0x2002) return true; // 6to4 (carries an IPv4 address)
  if (g(0) === 0x0100 && h.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
  return false;
}

/**
 * Is the IP address private, loopback, link local, reserved or unparseable?
 * `true` means the server must not connect to it. Accepts bracketed IPv6 and
 * zone IDs; IPv4-mapped, NAT64 and other embedded IPv4 forms are unwrapped.
 */
export function isPrivateIp(ip: string): boolean {
  let a = ip.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const family = isIP(a);
  if (family === 4) return isPrivateIpv4(a);
  if (family === 6) return isPrivateIpv6(a);
  return true;
}

/** One resolved address. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a host name to all of its addresses. Inject a fake one in tests. */
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** Minimal `fetch` signature used for metadata documents. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Error raised when a metadata document cannot be fetched safely. */
export class UnsafeFetchError extends Error {
  constructor(
    message: string,
    public readonly code: "not_public" | "bad_url" | "status" | "too_large" | "not_json" | "timeout" | "network" = "network",
  ) {
    super(message);
    this.name = "UnsafeFetchError";
  }
}

const defaultLookup: DnsLookup = async (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

async function resolvePublic(hostname: string, lookup: DnsLookup): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new UnsafeFetchError(`DNS lookup failed: ${err instanceof Error ? err.message : "unknown error"}`, "network");
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new UnsafeFetchError("address is not public", "not_public");
  return addresses;
}

/** Options of {@link fetchJsonSafely}. */
export interface SafeFetchOptions {
  /** Host name resolver; defaults to `dns.promises.lookup` with `all: true`. */
  lookup?: DnsLookup;
  /**
   * Custom fetch. When omitted, a built-in `node:https` client is used that
   * connects only to the addresses that passed the public-IP check (safe against
   * DNS rebinding). With a custom fetch the host is checked before the call, but
   * the connection itself cannot be pinned to the checked address.
   */
  fetch?: FetchLike;
  /** Timeout for the whole request in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Maximum body size in bytes (default 64 KiB). */
  maxBytes?: number;
}

/**
 * Fetches a JSON document with SSRF protection: https on the default port only,
 * IP literals and host names resolving to non-public addresses are refused,
 * redirects are not followed, no cookies or credentials are sent, and the
 * response is bounded in time and size.
 */
export async function fetchJsonSafely(url: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const lookup = options.lookup ?? defaultLookup;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeFetchError("invalid URL", "bad_url");
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) throw new UnsafeFetchError("only https on the default port", "bad_url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeFetchError("address is not public", "not_public");
  } else {
    // Resolve up front in both paths, so a private address is refused before any connection.
    await resolvePublic(host, lookup);
  }

  if (options.fetch) return fetchWithCustomFetch(u, options.fetch, timeoutMs, maxBytes);
  return fetchWithNodeHttps(u, lookup, timeoutMs, maxBytes);
}

async function fetchWithCustomFetch(u: URL, fetchFn: FetchLike, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchFn(u.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new UnsafeFetchError("timeout", "timeout");
      throw new UnsafeFetchError(err instanceof Error ? err.message : "network error", "network");
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new UnsafeFetchError(`status ${res.status}`, "status");
    }
    let text: string;
    try {
      text = await readLimitedText(res.body, maxBytes, res.headers.get("content-length"));
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw new UnsafeFetchError("document is too large", "too_large");
      if (controller.signal.aborted) throw new UnsafeFetchError("timeout", "timeout");
      throw new UnsafeFetchError("connection closed", "network");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new UnsafeFetchError("document is not JSON", "not_json");
    }
  } finally {
    clearTimeout(timer);
  }
}

function fetchWithNodeHttps(u: URL, lookup: DnsLookup, timeoutMs: number, maxBytes: number): Promise<unknown> {
  // The connection resolves the host again through this function, so every address it may use is re-checked.
  const guardedLookup: LookupFunction = (hostname, opts, callback) => {
    resolvePublic(hostname, lookup).then(
      (addresses) => {
        if (opts.all) callback(null, addresses);
        else callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
      },
      (err: Error) => callback(Object.assign(err, { code: "ENOTPUBLIC" }) as NodeJS.ErrnoException, opts.all ? [] : "", 0),
    );
  };

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err instanceof UnsafeFetchError ? err : new UnsafeFetchError(err.message, "network"));
      else resolve(value);
    };
    const req = httpsRequest(
      u,
      {
        method: "GET",
        agent: false,
        lookup: guardedLookup,
        headers: { accept: "application/json", "user-agent": "mcp-oauth-client-metadata-fetcher/1.0" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          return finish(new UnsafeFetchError(`status ${res.statusCode}`, "status"));
        }
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
          req.destroy();
          return finish(new UnsafeFetchError("document is too large", "too_large"));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            return finish(new UnsafeFetchError("document is too large", "too_large"));
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(new UnsafeFetchError("document is not JSON", "not_json"));
          }
        });
        res.on("error", (e) => finish(e));
        res.on("close", () => finish(new UnsafeFetchError("connection closed", "network")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(new UnsafeFetchError("timeout", "timeout"));
    }, timeoutMs);
    req.on("error", (e) => finish(e));
    req.end();
  });
}
