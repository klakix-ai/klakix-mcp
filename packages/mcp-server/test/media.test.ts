import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia, isPrivateAddress, MediaFetchError, sniffMediaType } from "../src/index.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const publicDns = async () => ["93.184.216.34"];

function ok(bytes: Uint8Array, headers: Record<string, string> = { "content-type": "image/png" }): Response {
  return new Response(bytes as BodyInit, { status: 200, headers });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaFetchError) return error.code;
    throw error;
  }
  return "no_error";
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("sniffMediaType", () => {
  it("detects common formats from magic numbers", () => {
    expect(sniffMediaType(PNG)).toBe("image/png");
    expect(sniffMediaType(MP4)).toBe("video/mp4");
    expect(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(new TextEncoder().encode("ID3\u0004\u0000"))).toBe("audio/mpeg");
    expect(sniffMediaType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffMediaType(new Uint8Array(0))).toBeNull();
  });
});

describe("fetchRemoteMedia", () => {
  it("downloads a public file and detects the type from the bytes", async () => {
    const fetch = vi.fn(async () => ok(PNG, { "content-type": "application/octet-stream" }));
    const media = await fetchRemoteMedia("https://cdn.example.com/a/cat%20photo.png", { expected: "image", maxBytes: 1000, resolveHost: publicDns, fetch });
    expect(media).toMatchObject({ mimeType: "image/png", kind: "image", size: PNG.byteLength, filename: "cat photo.png" });
    expect(media.bytes).toEqual(PNG);
    const [url, init, resolved] = fetch.mock.calls[0] as unknown as [URL, RequestInit, { hostname: string; addresses: string[] }];
    expect(url.hostname).toBe("cdn.example.com");
    expect(init.redirect).toBe("manual");
    expect(resolved).toEqual({ hostname: "cdn.example.com", addresses: ["93.184.216.34"] });
  });

  it.each(["http://127.0.0.1/a.png", "http://10.0.0.5/a.png", "http://169.254.169.254/latest/meta-data", "http://[::1]/a.png", "http://[::ffff:7f00:1]/a.png", "http://2130706433/a.png", "http://0x7f.1/a.png"])(
    "refuses the private address literal %s without calling fetch",
    async (url) => {
      const fetch = vi.fn();
      expect(await code(fetchRemoteMedia(url, { maxBytes: 1000, resolveHost: publicDns, fetch }))).toBe("blocked_address");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["http://localhost/a.png", "http://app.localhost/a.png", "http://printer.local/a.png", "http://db.internal/a.png", "http://localhost./a.png"])(
    "refuses the local name %s",
    async (url) => {
      const fetch = vi.fn();
      expect(await code(fetchRemoteMedia(url, { maxBytes: 1000, resolveHost: publicDns, fetch }))).toBe("blocked_address");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses a host name that resolves to a private address", async () => {
    const fetch = vi.fn();
    const resolveHost = vi.fn(async () => ["10.0.0.5"]);
    expect(await code(fetchRemoteMedia("https://evil.example.com/a.png", { maxBytes: 1000, resolveHost, fetch }))).toBe("blocked_address");
    expect(resolveHost).toHaveBeenCalledWith("evil.example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a host name when any one of its addresses is private", async () => {
    const fetch = vi.fn();
    const resolveHost = async () => ["93.184.216.34", "127.0.0.1"];
    expect(await code(fetchRemoteMedia("https://mixed.example.com/a.png", { maxBytes: 1000, resolveHost, fetch }))).toBe("blocked_address");
  });

  it("reports DNS failures", async () => {
    const resolveHost = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await code(fetchRemoteMedia("https://nowhere.example.com/a.png", { maxBytes: 1000, resolveHost, fetch: vi.fn() }))).toBe("dns_failed");
  });

  it("re-validates every redirect hop", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret.png" } }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, resolveHost: publicDns, fetch }))).toBe("blocked_address");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public host, and gives up after too many", async () => {
    const hops = vi.fn(async (url: URL) => (url.pathname === "/start" ? new Response(null, { status: 301, headers: { location: "https://other.example.com/final.png" } }) : ok(PNG)));
    const media = await fetchRemoteMedia("https://cdn.example.com/start", { maxBytes: 1000, resolveHost: publicDns, fetch: hops });
    expect(media.url).toBe("https://other.example.com/final.png");

    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/again" } }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/start", { maxBytes: 1000, resolveHost: publicDns, fetch: loop, maxRedirects: 2 }))).toBe("too_many_redirects");
    expect(loop).toHaveBeenCalledTimes(3);
  });

  it("rejects other protocols, credentials and invalid URLs", async () => {
    const options = { maxBytes: 1000, resolveHost: publicDns, fetch: vi.fn() };
    expect(await code(fetchRemoteMedia("file:///etc/passwd", options))).toBe("invalid_url");
    expect(await code(fetchRemoteMedia("ftp://example.com/a.png", options))).toBe("invalid_url");
    expect(await code(fetchRemoteMedia("https://user:pass@example.com/a.png", options))).toBe("invalid_url");
    expect(await code(fetchRemoteMedia("not a url", options))).toBe("invalid_url");
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("rejects a body whose declared length exceeds the limit", async () => {
    const fetch = vi.fn(async () => ok(PNG, { "content-type": "image/png", "content-length": "5000" }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, resolveHost: publicDns, fetch }))).toBe("too_large");
  });

  it("aborts a stream that grows past the limit even without a content length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { headers: { "content-type": "image/png" } }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, resolveHost: publicDns, fetch }))).toBe("too_large");
    expect(cancelled).toBe(true);
  });

  it("rejects HTML, SVG and files of the wrong kind", async () => {
    const html = vi.fn(async () => ok(new TextEncoder().encode("<html>"), { "content-type": "text/html" }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a", { maxBytes: 1000, resolveHost: publicDns, fetch: html }))).toBe("unsupported_type");
    const svg = vi.fn(async () => ok(new TextEncoder().encode("<svg/>"), { "content-type": "image/svg+xml" }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.svg", { maxBytes: 1000, resolveHost: publicDns, fetch: svg }))).toBe("unsupported_type");
    const video = vi.fn(async () => ok(MP4, { "content-type": "video/mp4" }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.mp4", { expected: "image", maxBytes: 1000, resolveHost: publicDns, fetch: video }))).toBe("unsupported_type");
    const labeled = vi.fn(async () => ok(new TextEncoder().encode("<html>"), { "content-type": "image/png" }));
    expect(await code(fetchRemoteMedia("https://cdn.example.com/fake.png", { maxBytes: 1000, resolveHost: publicDns, fetch: labeled }))).toBe("unsupported_type");
  });

  it("maps upstream failures and timeouts", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const failure = await fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, resolveHost: publicDns, fetch: notFound }).catch((e: MediaFetchError) => e);
    expect(failure).toMatchObject({ code: "http_error", status: 404 });

    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, resolveHost: publicDns, fetch: broken }))).toBe("download_failed");

    const hang = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    expect(await code(fetchRemoteMedia("https://cdn.example.com/a.png", { maxBytes: 1000, timeoutMs: 20, resolveHost: publicDns, fetch: hang }))).toBe("timeout");
  });
});
