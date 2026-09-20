import { applyMockAction, isKnownAction, MOCK_SCOPE_NOTE } from "@/mock/rules";
import { readMockRules, writeMockRules } from "@/mock/store";
import type { SessionManager } from "@/session-manager/manager";
import type { MockParams, MockResult, MockRule, RpcError } from "@/transport/types";
import { isRpcError, lookupSession } from "./shared";

/**
 * `tool.mock` — request-mocking rule CRUD.
 *
 * The rule table lives in `chrome.storage.local`, so this handler is a thin
 * read-modify-write over it. All the decision-making lives in
 * {@link applyMockAction}, which is pure and unit-tested; this layer only
 * handles session validation, storage failures and shaping the reply.
 *
 * Note what is *not* here: no tab resolution and no CDP. Rules are a property
 * of the browser profile, not of a tab, and the interceptor that consumes
 * them runs in every page. The `session_id` on the params is a routing handle
 * the daemon needs, not a scope.
 */

/** The slice of the rule table this handler needs, injected for testing. */
export interface MockStore {
  read(): Promise<MockRule[]>;
  write(rules: readonly MockRule[]): Promise<void>;
}

export interface MockDeps {
  store: MockStore;
}

function defaultStore(): MockStore {
  return {
    read: () => readMockRules(),
    write: (rules) => writeMockRules(rules),
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleMock(
  manager: SessionManager,
  params: MockParams,
  deps: MockDeps = { store: defaultStore() },
): Promise<MockResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "mock");
  if (isRpcError(ctxOrErr)) return ctxOrErr;

  if (!isKnownAction(params?.action)) {
    return {
      code: "invalid_params",
      message: `unknown mock action ${JSON.stringify(params?.action)}`,
    };
  }

  let current: MockRule[];
  try {
    current = await deps.store.read();
  } catch (err) {
    return {
      code: "protocol_error",
      message: `cannot read the mock rule table: ${describeError(err)}`,
    };
  }

  const outcome = applyMockAction(current, params);
  if (!outcome.ok) {
    return { code: "invalid_params", message: outcome.message };
  }

  // `list` must not write. A read that rewrites storage would wake every
  // page's `storage.onChanged` listener and re-push an identical rule set.
  if (params.action !== "list") {
    try {
      await deps.store.write(outcome.rules);
    } catch (err) {
      return {
        code: "protocol_error",
        message: `cannot write the mock rule table: ${describeError(err)}`,
      };
    }
  }

  const result: MockResult = {
    action: params.action,
    rules: outcome.rules,
    note: MOCK_SCOPE_NOTE,
  };
  if (outcome.createdId !== undefined) result.created_id = outcome.createdId;
  if (outcome.removed !== undefined) result.removed = outcome.removed;
  return result;
}
