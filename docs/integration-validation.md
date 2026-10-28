# moodle-docker and MDL-89973 validation

28 October 2026. The prior implementation (`9430dbb`) was fast-forwarded to harness
`main` and pushed before this increment. Compatibility and regression changes were
prepared on `feat/moodle-docker-ags-regression` for a final fast-forward to main.
No Moodle source or moodle-docker source changes were needed.

## Scope and evidence

[MDL-89973](https://moodle.atlassian.net/browse/MDL-89973) was read through the connected
Atlassian tool, including its description, Improvement type, affected versions,
status, labels, components and all four comments. The latest comment specifies
configurable provisional-score acceptance, preservation of existing grades, null/
omitted clearing, and rejection of stale updates even after clearing. This task
adds harness coverage, not a fix or backport for the Moodle issue. No Jira write,
comment, branch metadata update, transition or attachment was requested/performed.

The previous score action could not reproduce it because it always emitted
Completed/FullyGraded. New API/manual controls support all standard progress states,
custom positive maxima, decimals/extra credit, deliberate null/omitted scores,
caller timestamps, and an explicit target line item. Default numeric requests
remain Completed/FullyGraded. Input validation prevents accidental score omission
from becoming a destructive clear.

## Checks

Token values are omitted; the commands below refer to the locally exported test token.

| Exact command / action | Result |
| --- | --- |
| `npm run check` | Source/scenario/CLI syntax checks pass |
| `npm test` | 50 tests pass, including both corrected policies and detection of buggy behavior |
| `docker build -t lti-test-harness:local .` | Final image builds |
| `docker run --rm --entrypoint node -v /Users/mattp/projects/LTI_test_harness/test:/app/test:ro lti-test-harness:local --test` | All 50 tests pass inside final image |
| `./bin/phpcs /Users/mattp/projects/LTI_test_harness/_smoke_test/moodle-completion.php /Users/mattp/projects/LTI_test_harness/_smoke_test/moodle-fixture.php` from Moodle codex | Pass; scope: **whole file** for new observer and existing fixture |
| `MOODLE_DOCKER_LTI_HARNESS_TOKEN="$MOODLE_DOCKER_LTI_HARNESS_TOKEN" bin/moodle-docker-compose -f /Users/mattp/projects/LTI_test_harness/integrations/moodle-docker/lti-harness.yml config --quiet` from moodle-docker | Actual wrapper merges fragment successfully |
| Same wrapper/fragment plus `up -d --no-deps ltimock` | Created/updated only optional `moodlemaster-ltimock-1`; project-scoped volume |
| Moodle `curl` to `http://ltimock:8080/health` with 8080 allowed only in that PHP probe process | HTTP client errno 0, status ok |
| `docker exec moodlemaster-selenium-1 curl --fail --silent http://ltimock:8080/health` | Status ok from the existing browser-test network |
| `docker inspect moodlemaster-ltimock-1 lti-harness-moodle --format '{{.Name}} {{.State.Health.Status}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}'` | Both healthy, user node, read-only root |
| `git diff --check` | Pass |

The new Compose fragment uses no fixed container name, host port, external network
or absolute host paths. It inherits the wrapper's instance/project network and
namespace for its named volume. It exports opt-in environment variables to a newly
created webserver. It does not pretend those variables are consumed by existing
Moodle core tests or that starting only the tool changes an existing container's
environment. See [integration instructions](../integrations/moodle-docker/README.md).
The fragment was supplied with explicit `-f`; no new autoload switch is claimed.

## Real Moodle regression

Used the retained HTTPS tool and synthetic learner/activity on
`https://webserver`, Moodle 6.0dev, commit
`ddca0b0fb1e5c7c10575ccd9469d23594988f77c` on `lti-analysis/baseline-core`.
Site layout/config URL were confirmed before browsing. Only the dedicated course
and activity's completion configuration changed: automatic passing-grade completion,
maximum 100, pass mark 50. Site-wide completion was already enabled.

Configured through:

```sh
docker cp _smoke_test/moodle-completion.php moodlemaster-webserver-1:/tmp/lti-harness-completion.php
docker exec moodlemaster-webserver-1 php /tmp/lti-harness-completion.php /var/www/html/config.php 12 5 --configure
```

Then ran (with the local test token and public CA exported):

```sh
HARNESS_URL=https://lti-harness.127.0.0.1.nip.io:8444 \
LAUNCH_ID=4892e570-271f-4790-a38c-b1d0a9472d07 \
MOODLE_CONTAINER=moodlemaster-webserver-1 MOODLE_CMID=12 MOODLE_USERID=5 \
node _smoke_test/ags-partial-scores.js > _smoke_test/artifacts/moodle/MDL-89973.json
```

Repeat with `ACCEPT_PARTIAL_SCORES=true` and a separate JSON output file to assert
acceptance policy. This asserts the desired behavior; it does not enable an
unimplemented setting on this Moodle branch.

Both runs intentionally returned **exit 1**, exposing real platform regressions:

- Ignore-partial policy: four failing steps — Pending after final erased grade 80
  and passing completion; an older final score was accepted afterwards; older
  scores were also accepted after explicit null and omitted-score clears.
- Accept-partial policy: the same four failures plus Pending 60 did not create a
  passing grade/completion, exposing the original use case directly.
- Every score request returned **HTTP 200**. Grade values, grade modification times
  and completion were read from Moodle after each request; this was not inferred
  from protocol responses.
- Both runs restored **grade 83, passing completion 2** using a fresh final update.
  The runner removes its temporary observer copy. Fixture data and service remain.

The [issue guide](MDL-89973.md) contains the complete step/grade/completion table,
manual steps and precise payloads. Null and omitted score fields are distinct on
the wire. The observer does not recompute completion to make results look correct.
Both corrected policies are separately verified by independent scenario tests;
no patched Moodle checkout was installed or claimed to pass in this run.

Chrome manual testing used the new form to send Pending 60/InProgress at the
explicit activity line-item URL. The transcript showed the exact body and HTTP 200;
the observer showed grade null/completion 0, and the student's course displayed
**To do**. Invalid timestamp input produced the visible validation error. Labels
for all new controls appear correctly in the accessibility snapshot. Screenshot:
`_smoke_test/artifacts/moodle/MDL-89973-pending.png` (local/ignored).

## Single self peer-review

Exactly one pass for this increment after initial validation. Fixes were validated;
no second review pass was performed.

| Check | Y / N / - | Finding / disposition |
| --- | --- | --- |
| Default score behavior / strict validation | Y | Numeric defaults retained; clearing requires explicit intent |
| AGS progress / time payloads | Y | MUST FIX: explicit false/null timestamps must not default silently; fixed and tested |
| Restoration and cleanup | Y | MUST FIX: restore grade even if sequence aborts; moved to cleanup |
| Manual target visibility | Y | SHOULD FIX: display/override the line item so activity tests cannot use a saved standalone item accidentally; added and verified |
| Repeat-run ordering | Y | Runtime validation found second-resolution timing; fresh updates now cross that boundary, stale updates remain older; reruns reproduce the four intended failures |
| Data isolation | Y | Per-project volume; no Docker socket in service; observer runs only from explicit local CLI |
| Test claims | Y | HTTP 200 never substitutes for actual grade/completion assertions |
| Moodle and mobile WS scope | - | No Moodle source/WS change; real mobile not rerun |
| Patched Moodle acceptance policy | N | Tested in model only; unpatched real site correctly exposes failures |

No unresolved harness MUST FIX findings remain. Moodle's defects remain visible.

## Harness/tool handoff

- moodle-docker printed `Found orphan containers ...` for unrelated optional test
  services whose fragments were not selected. They were left untouched; no
  `--remove-orphans`, shared teardown, database reset or volume removal was used.
- The regression driver initially used tightly spaced timestamps; Moodle's
  second-resolution timestamps could make fresh messages appear stale. Fixed with
  paced fresh events; final reports above are from the corrected driver.
- Orchestrator verify was DEGRADED only for a stale sitemap. Code context was usable;
  the completion query identified `lib/completionlib.php`, and current known files
  plus runtime state supplied the actual completion settings/behavior.
- No Moodle wrapper failed. Initial observer PHPCS bootstrap-order error was fixed;
  full-file checks pass. No PHPUnit/Behat environment initialization was needed.

Jira reads: connected Atlassian tool. Jira writes/MCP write/API fallback/browser
write-back: none, not requested. No Jira narrative or metadata fields changed.
