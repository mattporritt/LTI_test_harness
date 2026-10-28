# Validation and handoff

This is the initial synthetic-platform validation record. See [real Moodle validation](moodle-validation.md) for the subsequent real-site run and current test counts.

28 October 2026. Branch `feat/standalone-lti-harness`, based on `fbd2d88`.
Implementation is standalone: no Moodle source, database or shared Docker stack
was changed. No Jira key applies; no Jira or Confluence writes were made. The
provided Jira development workflow was adapted to keep requirements and testing
instructions here. The connected Atlassian page-read tool supplied both source
documents. Orchestrator was not used: there was no Moodle code/pattern discovery.

## Results

| Exact command | Outcome |
| --- | --- |
| `npm run check` | All three source files pass Node syntax checks |
| `npm test` | 38 tests pass; zero failures |
| `docker build -t lti-test-harness:local .` | Final image builds successfully |
| `docker run --rm --entrypoint node -v /Users/mattp/projects/LTI_test_harness/test:/app/test:ro lti-test-harness:local --test` | All 38 tests pass inside the packaged runtime |
| `HARNESS_TOKEN=compose-validation-token docker compose -p lti-harness-compose-validation config --quiet` | Compose configuration valid; no stack mutation |
| `docker inspect lti-harness-validation --format '{{.State.Health.Status}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}'` | `healthy node true` |
| `docker exec lti-harness-validation node -e "fetch('http://127.0.0.1:8080/health').then(async r=>console.log(r.status,await r.text()))"` | HTTP 200, status `ok`, version `0.1.0` |
| `git diff --check` | Pass |

Final image: `lti-test-harness:local`, identifier
`sha256:eb614f6e6f3d5c1f1a6d53b23075d8657bd18af9b0bcd0ea0aa50911e552acd6`.
Base image is pinned by digest in the Dockerfile. Updating that digest should run
these checks again. No registry publication or remote CI execution was performed.
PHPCS scope: **not applicable** (no PHP files or Moodle source changes).

The dedicated Docker/browser setup used exactly the commands in
[testing instructions](testing.md), including `node _smoke_test/platform.js` and
`docker run -d --name lti-harness-validation --read-only --cap-drop ALL
--security-opt no-new-privileges -p 127.0.0.1:8089:8080
-e PUBLIC_URL=http://localhost:8089 -e HARNESS_TOKEN=browser-validation-token
-v lti-harness-validation-data:/data lti-test-harness:local`.
The validation container was replaced after fixes, retaining only its own volume.
This confirmed registration and capture persistence across container replacement.

Chrome manual interaction completed: authenticated registration form submission;
OIDC launch/form POST; verified claims; local quiz answer; AGS score with 204 at the
legacy `services.php` path with query parameters; NRPS roster with scoped token;
score 101 rejected with visible error; content selection and signed Deep Linking
return verified by the synthetic platform; read-only submission review showing the
learner's recorded answer; invalid signature rejected with visible error. Final
image reloaded the existing review capture correctly. Keyboard Tab focused the
answer field, its accessible label was `Your answer`, and its focus indicator was
a visible 3px outline. No horizontal overflow at the tested desktop viewport.
Screenshot: `_smoke_test/artifacts/launch-inspector.png` (local, ignored).

During initial validation, two test-fixture issues were corrected: the independent
OAuth vector needed the RFC's token secret, and test HTTP connections needed to
avoid pooled closed sockets during process restart. Browser testing found that
`Referrer-Policy: no-referrer` produced `Origin: null` on form submissions; changing
to `same-origin` fixed the forms while retaining strict origin checks and avoiding
cross-origin session referrers.

## Single self peer-review pass

Exactly one pass was performed after initial automated/browser validation. Fixes
were applied and affected checks rerun; no second peer-review pass was performed.

| Check | Y / N / - | Finding and disposition |
| --- | --- | --- |
| Valid anonymous LTI launches | Y | MUST FIX: optional subject and empty roles were wrongly refused. Fixed; anonymous grade submission explicitly refused; regression tests pass. |
| Submission-data isolation | Y | MUST FIX: history needed deployment ID as well as platform/user/resource. Fixed and covered by cross-deployment regression test. |
| Submission-review discovery | Y | MUST FIX: new line items did not advertise `submissionReview`. Added to AGS and Deep Linking line items; tested. |
| Content selection | Y | MUST FIX: echo/quiz marker did not change the page. Fixed; claims-only rendering tested. |
| JWT malformed payload handling | Y | MUST FIX: primitive JWT payload could produce an internal error. Reject with 400; tested. |
| Deep Linking compatibility | Y | SHOULD FIX: omit line item when `accept_lineitem` is false. Fixed and tested. |
| Replay, auth, output escaping, trusted origins | Y | Signature, state/nonce, CSRF, escape and outbound-origin rejection tests pass. |
| Docker/runtime and repeatable setup | Y | Non-root, persistent keys, read-only root, health and in-image tests pass. |
| Mobile/Web Services | - | No Moodle WS changed; real app flow not run. Integration instructions identify it explicitly. |
| Real Moodle / other-vendor interoperability | N | Separate acceptance pass remains; no claim of completion. |
| External LTI conformance certification | - | Not requested or claimed. |

No unresolved MUST FIX findings remain from this pass. Known first-release scope
limits are documented in [requirements](requirements.md).

## Harness/tool defects and workarounds

- **TWG CLI:** `twg whoami` failed with `OAuth refresh is due, but TWG cannot safely
  write /Users/mattp/.config/twg`, and `Update required ... v1.2.7 ... minimum ...
  v1.3.1`. No auth/update/config changes were attempted. Workaround: the connected
  Atlassian Confluence page-read tool retrieved both documents successfully.
- **Firefox MCP:** blank-page readiness returned `Error: Process (pid=20095)
  unexpectedly closed with status 0`. Workaround: Chrome MCP blank/data-page
  readiness and full interactive validation succeeded. Firefox cross-browser
  coverage remains unverified.
- **Sandboxed host curl:** `curl --fail http://localhost:8089/health` returned
  `curl: (7) Failed to connect to localhost port 8089 ... Couldn't connect to
  server`, while Chrome reached the service. Workaround: the exact `docker exec`
  health command in the table passed, and Chrome completed the browser flows.
- **Chrome screenshot file scope:** writing directly to the target repository
  returned `Access denied ... is not within any of the configured workspace roots`.
  Workaround: capture the screenshot in memory, then save its image data using
  an approved filesystem write to the ignored artifact directory. Visual evidence
  was saved and inspected.

These are environment/tool limitations, not failed protocol checks. Product
validation completed against the synthetic platform. Real Moodle, other LMSs,
Firefox and mobile app acceptance remain unverified. No Moodle wrappers failed;
no Behat initialization or shared environment recovery was required.

## Delivery

Local code commit requested; no push or remote publication requested. Jira read/
write paths, field updates, screenshots attached to Jira, API write fallback and
browser Jira fallback are all not applicable. The only app reads were the supplied
Confluence documents. Reproduce with README and testing instructions; reset only
the dedicated tool volume when intentionally discarding its data.
