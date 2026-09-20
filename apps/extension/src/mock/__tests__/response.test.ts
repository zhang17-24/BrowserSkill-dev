import { describe, expect, it } from "vitest";
import type { MockRule } from "@/transport/types";
import {
  base64ToBytes,
  decodeRuleBody,
  headersFromRule,
  isNullBodyStatus,
  responseInitFromRule,
  toResponse,
} from "../response";

function rule(overrides: Partial<MockRule> = {}): MockRule {
  return {
    enabled: true,
    url_pattern: "https://api.example.com/user/*",
    status: 200,
    headers: [],
    body: "",
    body_encoding: "text",
    ...overrides,
  };
}

describe("isNullBodyStatus", () => {
  it("flags the statuses that may not carry a body", () => {
    for (const status of [101, 103, 204, 205, 304]) {
      expect(isNullBodyStatus(status)).toBe(true);
    }
  });

  it("leaves ordinary statuses alone", () => {
    for (const status of [200, 201, 400, 404, 500]) {
      expect(isNullBodyStatus(status)).toBe(false);
    }
  });
});

describe("base64ToBytes", () => {
  it("decodes a known payload", () => {
    expect(Array.from(base64ToBytes("iVBORw=="))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("decodes the empty string to no bytes", () => {
    expect(base64ToBytes("").length).toBe(0);
  });
});

describe("decodeRuleBody", () => {
  it("encodes a text body as utf-8", () => {
    const bytes = decodeRuleBody(rule({ body: "火狐" }));
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("火狐");
  });

  it("decodes a base64 body to the original bytes", () => {
    const bytes = decodeRuleBody(rule({ body: "iVBORw==", body_encoding: "base64" }));
    expect(Array.from(bytes as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns null for an empty body so Response behaves like a real empty 200", () => {
    expect(decodeRuleBody(rule({ body: "" }))).toBeNull();
  });

  it("returns null for a status that may not carry a body", () => {
    // Handing Response a body for a 204 throws, so the body is dropped here
    // rather than surfacing as an unrelated TypeError in the page.
    expect(decodeRuleBody(rule({ status: 204, body: "nope" }))).toBeNull();
    expect(decodeRuleBody(rule({ status: 304, body: "nope" }))).toBeNull();
  });
});

describe("headersFromRule", () => {
  it("keeps the rule's own headers", () => {
    const headers = headersFromRule(
      rule({
        headers: [
          { name: "content-type", value: "application/vnd.custom+json" },
          { name: "x-trace", value: "abc" },
        ],
      }),
    );
    expect(headers["content-type"]).toBe("application/vnd.custom+json");
    expect(headers["x-trace"]).toBe("abc");
  });

  it("infers application/json for a json body", () => {
    expect(headersFromRule(rule({ body: '{"id":1}' }))["content-type"]).toBe("application/json");
  });

  it("infers application/json for a json array", () => {
    expect(headersFromRule(rule({ body: "[1,2]" }))["content-type"]).toBe("application/json");
  });

  it("falls back to text/plain for a non-json body", () => {
    expect(headersFromRule(rule({ body: "hello" }))["content-type"]).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("does not infer a content-type for an empty body", () => {
    expect(headersFromRule(rule({ body: "" }))["content-type"]).toBeUndefined();
  });

  it("does not infer a content-type for a null-body status", () => {
    expect(headersFromRule(rule({ status: 204, body: "x" }))["content-type"]).toBeUndefined();
  });

  it("defaults a binary body to octet-stream", () => {
    expect(
      headersFromRule(rule({ body: "iVBORw==", body_encoding: "base64" }))["content-type"],
    ).toBe("application/octet-stream");
  });

  it("never overrides an explicit content-type", () => {
    const headers = headersFromRule(
      rule({ body: '{"id":1}', headers: [{ name: "Content-Type", value: "text/plain" }] }),
    );
    expect(headers["Content-Type"]).toBe("text/plain");
    expect(headers["content-type"]).toBeUndefined();
  });
});

describe("toResponse", () => {
  it("carries the status, body and headers onto a real Response", async () => {
    const response = toResponse(
      rule({
        status: 503,
        body: '{"error":"down"}',
        headers: [{ name: "retry-after", value: "30" }],
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"error":"down"}');
  });

  it("builds a response for a null-body status without throwing", async () => {
    const response = toResponse(rule({ status: 204, body: "ignored" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("preserves binary bytes through base64", async () => {
    const response = toResponse(
      rule({ body: "iVBORw==", body_encoding: "base64", status: 200 }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("parses a json body with response.json()", async () => {
    const response = toResponse(rule({ body: '{"id":1,"name":"mock"}' }));
    expect(await response.json()).toEqual({ id: 1, name: "mock" });
  });
});

describe("responseInitFromRule", () => {
  it("exposes status and headers", () => {
    const init = responseInitFromRule(rule({ status: 418 }));
    expect(init.status).toBe(418);
    expect(init.headers).toBeDefined();
  });
});
