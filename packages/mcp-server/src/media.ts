/**
 * SSRF-safe download of media files from user supplied URLs.
 *
 * Tools that accept a "public URL" for an image, video or audio file are a
 * classic server-side request forgery vector: the caller can point the server
 * at `http://169.254.169.254/` or an internal admin panel. `fetchRemoteMedia`
 * closes that door:
 *
 * - only `http:` and `https:`, no credentials in the URL;
 * - the host must resolve to public addresses only (every returned address is
 *   checked, IPv4-mapped, NAT64 and 6to4 IPv6 forms included);
 * - redirects are followed manually and every hop is checked again;
 * - the body is read as a stream and aborted once it passes `maxBytes`;
 * - the content type is taken from the bytes (magic numbers), never from the
 *   response header, and anything that is not a recognized image, video or
 *   audio format is rejected.
 */

/** Kinds of media the fetcher accepts. */
export type MediaKind = "image" | "video" | "audio";

/** Reasons a fetch can fail; see {@link MediaFetchError}. */
export type MediaFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "dns_failed"
  | "http_error"
  | "download_failed"
  | "too_large"
  | "too_many_redirects"
  | "unsupported_type"
  | "timeout";

/** Error thrown by {@link fetchRemoteMedia}. `code` is stable and safe to branch on. */
export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  /** Upstream HTTP status for `http_error`. */
  readonly status?: number;
  constructor(code: MediaFetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = "MediaFetchError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Addresses a host name was resolved to, handed to a custom `fetch` so it can pin the connection. */
export interface ResolvedHost {
  hostname: string;
  /** Public addresses the host resolved to (already validated). */
  addresses: readonly string[];
}

/** Options of {@link fetchRemoteMedia}. */
export interface FetchRemoteMediaOptions {
  /** Reject files whose detected kind differs from this. */
  expected?: MediaKind;
  /** Largest accepted body in bytes. */
  maxBytes: number;
  /** Total time budget for the download, redirects included. Default 30 000. */
  timeoutMs?: number;
  /** Redirects to follow, each re-validated. Default 3. */
  maxRedirects?: number;
  /** Abort signal of the caller. */
  signal?: AbortSignal;
  /** `User-Agent` sent upstream. Default `mcp-server-media-fetcher/1.0`. */
  userAgent?: string;
  /**
   * Replacement for `globalThis.fetch`. It receives the validated addresses
   * so it can pin the TCP connection to them (for example an undici `Agent`
   * whose `connect.lookup` returns one of `resolved.addresses`). The default
   * `fetch` lets the runtime resolve the name a second time, which leaves a
   * small DNS rebinding window; pass a pinning `fetch` where that matters.
   * Always called with `redirect: "manual"`.
   */
  fetch?: (url: URL, init: RequestInit, resolved: ResolvedHost) => Promise<Response>;
  /**
   * Replacement for DNS resolution. Must return every address of the host.
   * The default uses `node:dns/promises` (Node, Bun, Workers with Node compat).
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/** A downloaded file. */
export interface RemoteMedia {
  bytes: Uint8Array;
  /** MIME type detected from the content. */
  mimeType: string;
  kind: MediaKind;
  /** Length of `bytes`. */
  size: number;
  /** Final URL after redirects. */
  url: string;
  /** Last path segment of the final URL, or `file`. */
  filename: string;
}

/* ------------------------------------------------------------------ */
/* Address classification                                              */
/* ------------------------------------------------------------------ */

function parseIPv4(text: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;
  const parts = text.split(".").map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function parseIPv6(input: string): number[] | null {
  let text = (input.split("%")[0] ?? "").toLowerCase();
  if (!text.includes(":")) return null;
  let v4Tail: number[] | null = null;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4Tail = parseIPv4(tail);
    if (!v4Tail) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string | undefined) => (s ? s.split(":") : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const value = parseInt(g, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (v4Tail) bytes.splice(12, 4, ...v4Tail);
  return bytes;
}

function isPrivateIPv4(b: number[]): boolean {
  const a = b[0] ?? 0;
  const c = b[1] ?? 0;
  const d = b[2] ?? 0;
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && c >= 64 && c <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && d === 0) || // IETF protocol assignments
    (a === 192 && c === 0 && d === 2) || // documentation
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * True when `ip` is not a routable public address: private, loopback,
 * link-local, carrier-grade NAT, multicast, documentation, reserved, or an
 * IPv6 form that wraps such an IPv4 address. Strings that are not an IP
 * address count as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateIPv4(v4);
  const b = parseIPv6(ip);
  if (!b) return true;
  const at = (i: number) => b[i] ?? 0;
  if (b.slice(0, 12).every((x) => x === 0)) return true; // ::, ::1 and the deprecated IPv4-compatible range
  if (b.slice(0, 10).every((x) => x === 0) && at(10) === 0xff && at(11) === 0xff) return isPrivateIPv4(b.slice(12)); // IPv4-mapped
  if (at(0) === 0 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) {
    // NAT64: 64:ff9b::/96 wraps an IPv4 address, 64:ff9b:1::/48 is local use.
    return b.slice(4, 12).every((x) => x === 0) ? isPrivateIPv4(b.slice(12)) : true;
  }
  if (at(0) === 0x20 && at(1) === 0x02) return isPrivateIPv4(b.slice(2, 6)); // 6to4
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0 && at(3) === 0) return true; // Teredo
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return true; // documentation
  if (at(0) === 0x01 && b.slice(1, 8).every((x) => x === 0)) return true; // discard-only 100::/64
  if ((at(0) & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (at(0) === 0xfe && (at(1) & 0xc0) >= 0x80) return true; // link-local fe80::/10 and site-local fec0::/10
  if (at(0) === 0xff) return true; // multicast
  return false;
}

const LOCAL_NAMES = /^(localhost|.+\.localhost|.+\.local|.+\.localdomain|.+\.internal|.+\.home\.arpa)$/i;

async function defaultResolve(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** Resolves `hostname` and returns its addresses, or throws when any of them is not public. */
async function resolvePublicHost(hostname: string, resolve: (h: string) => Promise<string[]>): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (parseIPv4(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new MediaFetchError("blocked_address", "The URL points to a private or reserved network address.");
    return [host];
  }
  if (LOCAL_NAMES.test(host)) throw new MediaFetchError("blocked_address", "The URL points to a local host name.");
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new MediaFetchError("dns_failed", "The host name could not be resolved.");
  }
  if (!addresses.length) throw new MediaFetchError("dns_failed", "The host name could not be resolved.");
  if (addresses.some(isPrivateAddress)) throw new MediaFetchError("blocked_address", "The host name resolves to a private or reserved network address.");
  return addresses;
}

/* ------------------------------------------------------------------ */
/* Content sniffing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Detects a media MIME type from the first bytes of a file. Returns `null`
 * when the signature is not a known image, video or audio format.
 */
export function sniffMediaType(head: Uint8Array): string | null {
  const text = (start: number, length: number) => String.fromCharCode(...head.subarray(start, start + length));
  const at = (i: number) => head[i] ?? 0;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && text(1, 3) === "PNG") return "image/png";
  if (text(0, 4) === "GIF8") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") return "image/webp";
  if (text(0, 4) === "RIFF" && text(8, 4) === "WAVE") return "audio/wav";
  if (text(0, 4) === "RIFF" && text(8, 4) === "AVI ") return "video/x-msvideo";
  if (text(4, 4) === "ftyp") {
    const brand = text(8, 4);
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "image/heic";
    if (brand === "avif") return "image/avif";
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "video/webm";
  if (text(0, 4) === "OggS") return "audio/ogg";
  if (text(0, 4) === "fLaC") return "audio/flac";
  if (text(0, 3) === "ID3" || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

function kindOf(mimeType: string): MediaKind | null {
  const top = mimeType.split("/")[0];
  return top === "image" || top === "video" || top === "audio" ? top : null;
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new MediaFetchError("download_failed", "The response had no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MediaFetchError("too_large", `The file is larger than the ${maxBytes} byte limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Downloads an image, video or audio file from a public URL, refusing
 * anything that could reach a private network.
 *
 * @throws {MediaFetchError} with a stable `code`; the message is safe to show to the caller.
 *
 * @example
 * ```ts
 * const { bytes, mimeType } = await fetchRemoteMedia("https://example.com/cat.png", {
 *   expected: "image",
 *   maxBytes: 10 * 1024 * 1024,
 * });
 * ```
 */
export async function fetchRemoteMedia(input: string | URL, options: FetchRemoteMediaOptions): Promise<RemoteMedia> {
  const maxRedirects = options.maxRedirects ?? 3;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const doFetch = options.fetch ?? ((url: URL, init: RequestInit) => globalThis.fetch(url, init));
  const resolve = options.resolveHost ?? defaultResolve;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MediaFetchError("invalid_url", "The link is not a valid URL. Give a public http(s) address.");
  }

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new MediaFetchError("invalid_url", "Only http and https links are supported.");
      if (url.username || url.password) throw new MediaFetchError("invalid_url", "Links with embedded credentials are not allowed.");

      const addresses = await resolvePublicHost(url.hostname, resolve);
      let response: Response;
      try {
        response = await doFetch(
          url,
          {
            redirect: "manual",
            signal,
            headers: { "User-Agent": options.userAgent ?? "mcp-server-media-fetcher/1.0", Accept: "image/*,video/*,audio/*;q=0.9,*/*;q=0.5" },
          },
          { hostname: url.hostname, addresses },
        );
      } catch (error) {
        if (error instanceof MediaFetchError) throw error;
        if (signal.aborted) throw new MediaFetchError("timeout", "Downloading the file took too long or was aborted.");
        throw new MediaFetchError("download_failed", "The file could not be downloaded from that link.");
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new MediaFetchError("http_error", `The link answered ${response.status} without a redirect target.`, response.status);
        try {
          url = new URL(location, url);
        } catch {
          throw new MediaFetchError("invalid_url", "The link redirects to an invalid URL.");
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("http_error", `The link returned HTTP ${response.status}.`, response.status);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("too_large", `The file is larger than the ${options.maxBytes} byte limit.`);
      }

      const bytes = await readBody(response, options.maxBytes);
      // Only the bytes decide the type: servers often send octet-stream, a wrong label, or a scriptable
      // format such as SVG under an image type.
      const mimeType = sniffMediaType(bytes.subarray(0, 16));
      const kind = mimeType ? kindOf(mimeType) : null;
      if (!mimeType || !kind) throw new MediaFetchError("unsupported_type", "The file is not a recognized image, video or audio format.");
      if (options.expected && kind !== options.expected) {
        throw new MediaFetchError("unsupported_type", `Expected ${options.expected} but the file is ${kind} (${mimeType}).`);
      }

      let filename = "file";
      try {
        filename = decodeURIComponent(url.pathname.split("/").pop() || "file").slice(0, 120);
      } catch {
        // keep the default
      }
      return { bytes, mimeType, kind, size: bytes.byteLength, url: url.toString(), filename };
    }
    throw new MediaFetchError("too_many_redirects", "The link redirects too many times.");
  } catch (error) {
    if (error instanceof MediaFetchError) throw error;
    if (signal.aborted) throw new MediaFetchError("timeout", "Downloading the file took too long or was aborted.");
    throw new MediaFetchError("download_failed", "The file could not be downloaded from that link.");
  }
}
