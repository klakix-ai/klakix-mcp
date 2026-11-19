import { describe, expect, it, vi } from "vitest";
import { fetchJsonSafely, isPrivateIp, type DnsLookup, type FetchLike } from "../src/index.js";

const publicDns: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateDns: DnsLookup = async () => [{ address: "10.0.0.7", family: 4 }];
const mixedDns: DnsLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "::1", family: 6 },
];

describe("isPrivateIp", () => {
  it("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.17.0.2", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("refuses private IPv6 and embedded private IPv4", () => {
    for (const ip of ["::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "fd00::1", "fe80::1%eth0", "ff02::1", "64:ff9b::a00:1", "2002:c0a8:101::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses and refuses non-IPs", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.16.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
    expect(isPrivateIp("localhost")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("fetchJsonSafely", () => {
  const url = "https://client.example/meta.json";
  const okFetch = (body: string, init: ResponseInit = {}) => vi.fn<FetchLike>(async () => new Response(body, { status: 200, ...init }));

  it("refuses non-https URLs and explicit ports before any network use", async () => {
    const fetch = okFetch("{}");
    await expect(fetchJsonSafely("http://client.example/x.json", { fetch, lookup: publicDns })).rejects.toMatchObject({ code: "bad_url" });
    await expect(fetchJsonSafely("https://client.example:8443/x.json", { fetch, lookup: publicDns })).rejects.toMatchObject({ code: "bad_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses private IP literals", async () => {
    const fetch = okFetch("{}");
    await expect(fetchJsonSafely("https://169.254.169.254/latest/meta-data", { fetch })).rejects.toMatchObject({ code: "not_public" });
    await expect(fetchJsonSafely("https://[::1]/x.json", { fetch })).rejects.toMatchObject({ code: "not_public" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses host names that resolve to a private address (custom fetch)", async () => {
    const fetch = okFetch("{}");
    await expect(fetchJsonSafely(url, { fetch, lookup: privateDns })).rejects.toMatchObject({ code: "not_public" });
    await expect(fetchJsonSafely(url, { fetch, lookup: mixedDns })).rejects.toMatchObject({ code: "not_public" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses private resolution with the built-in https client (no connection is made)", async () => {
    await expect(fetchJsonSafely(url, { lookup: privateDns })).rejects.toMatchObject({ code: "not_public" });
  });

  it("does not follow redirects and bounds size", async () => {
    const redirect = vi.fn<FetchLike>(async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } }));
    await expect(fetchJsonSafely(url, { fetch: redirect, lookup: publicDns })).rejects.toMatchObject({ code: "status" });
    expect(redirect.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", method: "GET" });

    await expect(fetchJsonSafely(url, { fetch: okFetch("x".repeat(2000)), lookup: publicDns, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
    await expect(
      fetchJsonSafely(url, { fetch: okFetch("{}", { headers: { "content-length": "999999" } }), lookup: publicDns, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchJsonSafely(url, { fetch: okFetch("not json"), lookup: publicDns })).rejects.toMatchObject({ code: "not_json" });
  });

  it("times out", async () => {
    const hang: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchJsonSafely(url, { fetch: hang, lookup: publicDns, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("returns parsed JSON for a public host", async () => {
    await expect(fetchJsonSafely(url, { fetch: okFetch('{"a":1}'), lookup: publicDns })).resolves.toEqual({ a: 1 });
  });
});
