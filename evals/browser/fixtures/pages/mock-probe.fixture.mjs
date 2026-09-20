import { page, withRun } from "../../lib/fixtures.mjs";

// The page calls the fixture backend and reports which payload it actually
// received. `source` is the whole point: the backend answers `real`, so a
// `mock` reading can only come from a rule that replaced the response before
// the network was reached. `data.source` is what the case asserts on.
export default {
  id: "mock-probe",
  routes: ["/mock/probe"],
  render({ runId }) {
    const endpoint = withRun("/api/mock-probe", runId);
    return page({
      title: "Mock response override probe",
      body: `
        <h1>Mock response override</h1>
        <p class="muted">This page calls the fixture backend once per load and reports the payload it received.</p>
        <div class="marker" id="probe-result">waiting</div>
        <p><button id="probe-again" type="button">Probe again</button></p>
      `,
      script: `
        const endpoint = ${JSON.stringify(endpoint)};
        const output = document.getElementById("probe-result");
        let probeCount = 0;

        async function probe() {
          probeCount += 1;
          try {
            const response = await fetch(endpoint);
            const payload = await response.json();
            output.textContent = payload.source + " / " + payload.token;
            browserEval.send("mock.probe", {
              source: payload.source,
              token: payload.token,
              status: response.status,
              probe: probeCount,
            });
          } catch (error) {
            output.textContent = "probe failed";
            browserEval.send("mock.probe", {
              source: "error",
              token: String(error && error.message),
              probe: probeCount,
            });
          }
        }

        document.getElementById("probe-again").addEventListener("click", probe);
        window.addEventListener("load", probe);
      `,
    });
  },
};
