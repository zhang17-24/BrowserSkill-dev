import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@/session-manager/manager";
import type { MockParams, MockRule } from "@/transport/types";
import { handleMock, type MockStore } from "../mock";

const SESSION = "abcd";

function fakeManager(sessionId = SESSION): SessionManager {
  return {
    get: (id: string) => (id === sessionId ? { sessionId } : null),
  } as unknown as SessionManager;
}

function memoryStore(initial: MockRule[] = []): MockStore & { rules: MockRule[] } {
  const store = {
    rules: [...initial],
    read: async () => [...store.rules],
    write: async (next: readonly MockRule[]) => {
      store.rules = [...next];
    },
  };
  return store;
}

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

function params(overrides: Partial<MockParams>): MockParams {
  return { session_id: SESSION, action: "list", ...overrides };
}

function isError(value: unknown): value is { code: string; message: string } {
  return typeof value === "object" && value !== null && "code" in value;
}

describe("handleMock session validation", () => {
  it("rejects a missing session_id", async () => {
    const result = await handleMock(fakeManager(), params({ session_id: "" }), {
      store: memoryStore(),
    });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("invalid_params");
    expect(result.message).toContain("session_id");
  });

  it("rejects an unknown session", async () => {
    const result = await handleMock(fakeManager(), params({ session_id: "zzzz" }), {
      store: memoryStore(),
    });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("not_found");
  });

  it("rejects an unknown action", async () => {
    const result = await handleMock(
      fakeManager(),
      { session_id: SESSION, action: "explode" as MockParams["action"] },
      { store: memoryStore() },
    );
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("invalid_params");
    expect(result.message).toContain("explode");
  });
});

describe("handleMock actions", () => {
  it("add stores the rule and reports the minted id", async () => {
    const store = memoryStore();
    const result = await handleMock(
      fakeManager(),
      params({ action: "add", rule: rule({ body: "火狐" }) }),
      { store },
    );

    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.action).toBe("add");
    expect(result.created_id).toMatch(/^m_/);
    expect(result.rules).toHaveLength(1);
    expect(store.rules).toHaveLength(1);
    expect(store.rules[0]?.body).toBe("火狐");
  });

  it("list returns the current set and never writes", async () => {
    const store = memoryStore([rule({ id: "m_1" })]);
    const write = vi.spyOn(store, "write");

    const result = await handleMock(fakeManager(), params({ action: "list" }), { store });

    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.rules.map((r) => r.id)).toEqual(["m_1"]);
    // A read that rewrites storage would wake every page's storage listener.
    expect(write).not.toHaveBeenCalled();
  });

  it("remove deletes by id", async () => {
    const store = memoryStore([rule({ id: "m_1" }), rule({ id: "m_2" })]);
    const result = await handleMock(fakeManager(), params({ action: "remove", id: "m_1" }), {
      store,
    });

    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.rules.map((r) => r.id)).toEqual(["m_2"]);
    expect(result.removed).toBe(1);
    expect(store.rules.map((r) => r.id)).toEqual(["m_2"]);
  });

  it("clear empties the table", async () => {
    const store = memoryStore([rule({ id: "m_1" }), rule({ id: "m_2" })]);
    const result = await handleMock(fakeManager(), params({ action: "clear" }), { store });

    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.rules).toEqual([]);
    expect(result.removed).toBe(2);
    expect(store.rules).toEqual([]);
  });

  it("replace_all swaps the whole set", async () => {
    const store = memoryStore([rule({ id: "m_old" })]);
    const result = await handleMock(
      fakeManager(),
      params({ action: "replace_all", rules: [rule({ url_pattern: "https://b.test/x" })] }),
      { store },
    );

    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.url_pattern).toBe("https://b.test/x");
    expect(store.rules[0]?.url_pattern).toBe("https://b.test/x");
  });

  it("leaves storage untouched when a rule is rejected", async () => {
    const store = memoryStore([rule({ id: "m_1" })]);
    const write = vi.spyOn(store, "write");

    const result = await handleMock(
      fakeManager(),
      params({ action: "add", rule: rule({ status: 999 }) }),
      { store },
    );

    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("invalid_params");
    expect(write).not.toHaveBeenCalled();
    expect(store.rules.map((r) => r.id)).toEqual(["m_1"]);
  });

  it("reports a read failure as a protocol error", async () => {
    const store: MockStore = {
      read: async () => {
        throw new Error("storage exploded");
      },
      write: async () => {},
    };
    const result = await handleMock(fakeManager(), params({ action: "list" }), { store });

    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("protocol_error");
    expect(result.message).toContain("storage exploded");
  });

  it("reports a write failure as a protocol error", async () => {
    const store: MockStore = {
      read: async () => [],
      write: async () => {
        throw new Error("quota exceeded");
      },
    };
    const result = await handleMock(fakeManager(), params({ action: "add", rule: rule() }), {
      store,
    });

    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.code).toBe("protocol_error");
    expect(result.message).toContain("quota exceeded");
  });

  it("echoes the browser-profile scope so agents learn the reach of a rule", async () => {
    const result = await handleMock(fakeManager(), params({ action: "list" }), {
      store: memoryStore(),
    });
    expect(isError(result)).toBe(false);
    if (isError(result)) return;
    expect(result.note).toContain("every tab");
  });
});
