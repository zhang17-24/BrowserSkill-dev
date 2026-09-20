function readPath(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value);
}

function eventMatches(event, assertion) {
  if (event.type !== assertion.type) return false;
  return Object.entries(assertion.where ?? {}).every(
    ([path, expected]) => readPath(event, path) === expected,
  );
}

export function verifyTask(task, { events = [], responseText = "", adapterEvidence = {} } = {}) {
  const site = task.siteAssertions.map((assertion) => {
    const actual = events.filter((event) => eventMatches(event, assertion)).length;
    // `minCount` alone can only say "this happened". Some properties are
    // defined by something *not* happening — "the origin server was never
    // contacted" is the one that separates a mocked response from a redirect
    // — so an optional `maxCount` bounds the count from above.
    const min = assertion.minCount ?? 0;
    const max = assertion.maxCount ?? Number.POSITIVE_INFINITY;
    return {
      kind: "site",
      label: assertion.label,
      status: actual >= min && actual <= max ? "passed" : "failed",
      expected: Number.isFinite(max) ? `between ${min} and ${max}` : `at least ${min}`,
      actual,
    };
  });

  const response = task.responseAssertions.map((assertion) => ({
    kind: "response",
    label: assertion.label,
    status: responseText.includes(assertion.includes) ? "passed" : "failed",
    expected: `response includes ${JSON.stringify(assertion.includes)}`,
  }));

  const adapter = task.adapterAssertions.map((assertion) => {
    if (!Object.hasOwn(adapterEvidence, assertion.key)) {
      return {
        kind: "adapter",
        label: assertion.label,
        status: "unverified",
        expected: assertion.key,
      };
    }
    return {
      kind: "adapter",
      label: assertion.label,
      status: adapterEvidence[assertion.key] ? "passed" : "failed",
      expected: assertion.key,
      actual: adapterEvidence[assertion.key],
    };
  });

  const checks = [...site, ...response, ...adapter];
  const failed = checks.filter(({ status }) => status === "failed").length;
  const unverified = checks.filter(({ status }) => status === "unverified").length;
  return {
    taskId: task.id,
    status: failed > 0 ? "failed" : unverified > 0 ? "passed-with-unverified" : "passed",
    summary: {
      passed: checks.length - failed - unverified,
      failed,
      unverified,
      total: checks.length,
    },
    checks,
  };
}
