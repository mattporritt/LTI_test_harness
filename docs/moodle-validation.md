# Real Moodle integration validation

28 October 2026. Tested at `https://webserver` on Moodle **6.0dev (Build: 20261021)**,
branch `lti-analysis/baseline-core`, commit `ddca0b0fb1e5c7c10575ccd9469d23594988f77c`.
This is the LTI project's core_ltix development baseline, not a released Moodle version.
No Moodle source edits or branch changes were made. The existing site was installed;
no reinstall, database reset, PHPUnit/Behat initialization or plugin upgrade was needed.

## Passing real-platform flows

| Flow | Evidence |
| --- | --- |
| Admin registration | Created a manual LTI 1.3 tool through Moodle's rendered configuration form; enabled AGS/NRPS and the activity placement |
| OIDC launch | Admin and synthetic enrolled student launched from Moodle into the HTTPS tool; issuer, signature, client/deployment, state and nonce verified |
| Numeric-ID compatibility | Default strict mode correctly refused the numeric ID; explicit compatibility mode accepted it with a visible warning and raw claim preserved |
| Interactive content | Student submitted quiz answer 4 and received local result 100 |
| AGS score / results | Signed client assertion obtained a scoped token; score POST and results GET succeeded; returned result score was 83 for student 5 |
| AGS collection | GET returned the actual activity line item; its exact path/query were retained |
| NRPS | GET returned the enrolled student, teacher and enrolled administrator; smoke script asserted the launching learner was present |
| Standalone line item | Explicit `resourceLinkId:null` created a line item (201), including submissionReview URL; score 77 succeeded |
| LTI 1.1 | Signed student launch succeeded; signed Basic Outcomes replaceResult returned success and grade 91 |
| Actual gradebook | Student's Moodle user report visibly displayed modern 83.00, legacy 91.00 and standalone 77.00 |
| Persistence | Tool container was replaced with the same volume; original captured launch ID and advertised service URL still worked without a new launch |
| Repeatable assertions | `_smoke_test/moodle-services.js` passed against real Moodle: roster membership, score, returned result and legacy outcome assertions |

Synthetic fixture course: ID 4 (`LTI-HARNESS-20261028`), modern activity CMID 12,
legacy activity CMID 13. Only the new harness tool types 5/6 and their placements
were configured. Test accounts and course were retained so the setup is usable.
The script can be rerun without creating duplicate fixture users/course/activities.
The separate teacher account was enrolled and returned by NRPS; teacher-only UI
checks used the administrator's instructor capabilities, not that account's login.

## Development-branch failures exposed by the tool

These were tested and remain failures; they were not hidden by harness workarounds.

1. **Numeric resource ID.** The resource launch contains `resource_link.id:8`, a
   number. Strict mode rejects it with `resource_link.id must be a non-empty string`.
   All subsequent real 1.3 resource checks used the explicit compatibility option.
   The harness still preserves the raw number and a protocol warning.
2. **Deep Linking authentication.** The real **Select content** button opened an
   iframe, but Moodle's `/ltix/auth.php` rejected its JSON message hint with
   `Error decoding lti_message_hint JWT: {"launchid":"..."}`. No Deep Linking JWT
   reached the tool, so real content selection/return could not complete.
3. **Submission review authentication.** A grade-report launch through
   `/mod/lti/launch.php?id=12&action=gradeReport&user=5` failed in the same Moodle
   authenticator, with a JSON `cmid`/`launchid` hint. It never reached the tool.
4. **Launch-derived line-item association.** The launch uses resource-link ID 8,
   while the AGS collection identifies the activity as `resourceLinkId:"10"`.
   Creating a line item using the unchanged launch-derived value returned 403.
   Explicit standalone creation succeeded; no automatic ID remapping was added.
5. **Legacy stored service path.** A score request to the preserved
   `/mod/lti/services.php/4/lineitems/11/lineitem/scores?type_id=5` path returned 409,
   while the advertised `/ltix/services.php/...` path succeeded. This is a failed
   legacy-URL migration check, not a passing T-PATH gate.

The independent synthetic platform still passes Deep Linking and submission-review
coverage. That does not establish those two real Moodle flows as working. Mobile,
Firefox, released Moodle versions, other LMSs, backup/restore and course-copy
workflows were not tested in this run. No Jira issue was created or modified.

## Setup and environment recovery

Two independent containers were added on `moodlemaster_default`:
`lti-harness-moodle` and `lti-harness-moodle-tls`. Tool URL:
`https://lti-harness.127.0.0.1.nip.io:8444`. Browser DNS uses loopback; Docker DNS
uses the dedicated proxy alias. A 30-day certificate was signed using the existing
development CA. Only its public certificate was mounted into the tool. TLS
verification stayed enabled throughout; no host-file edits were needed.

The existing Moodle settings allowed outbound ports 80/443 only. **8444** was added,
preserving those entries, and Moodle's own `curl` class successfully read tool health.
The two dedicated tool placements were explicitly enabled; the modern placement's
Deep Linking URL was set to the harness launch URI. Settings were retained for reuse.

The HTTP/2 Apache/PHP-FPM environment dropped Authorization headers: token issuance
succeeded but all service calls were 401, including a replay from inside Moodle.
An authenticated `phpinfo` header probe confirmed the header was absent. Added only
`/etc/apache2/conf-enabled/lti-harness-auth-forward.conf` inside the test container:

```apache
SetEnvIfNoCase Authorization "(.+)" HTTP_AUTHORIZATION=$1
```

Then ran `docker exec moodlemaster-webserver-1 apachectl graceful`. All AGS/NRPS
requests passed afterwards. No shared containers were stopped or recreated. This
runtime configuration should be carried into the HTTP/2 container's source config
if it needs to survive recreation; that separate repository was not edited.

The dedicated proxy initially failed 502 with `upstream sent too big header` due
to Moodle's large signed OIDC hint. Added `proxy_buffer_size 32k` and
`proxy_buffers 8 32k`, now included in `_smoke_test/nginx-moodle.conf`. Reloading
immediately after editing a bind mount briefly saw a partially synchronized file;
a subsequent `nginx -T` validated it and `nginx -s reload` succeeded. A fresh browser
tab used the new worker configuration. These were setup failures, not tool protocol failures.

Containers, test volume, fixture course and local test credentials were retained.
Local credentials: `_smoke_test/artifacts/moodle/runtime.env` (ignored, mode 0600).
Gradebook screenshot: `_smoke_test/artifacts/moodle/gradebook.png` (ignored).

## Exact validation commands

Run from the harness repo unless a command states otherwise. The real container
startup commands and environment options are in [Moodle setup](moodle.md).

```sh
npm run check
npm test
docker build -t lti-test-harness:local .
docker run --rm --entrypoint node \
  -v /Users/mattp/projects/LTI_test_harness/test:/app/test:ro \
  lti-test-harness:local --test
```

All **40 tests passed on host and inside the final image**. The build succeeded.

Actual real-service assertion command (token value omitted here; use local env):

```sh
docker exec -i \
  -e HARNESS_URL=http://127.0.0.1:8080 -e HARNESS_TOKEN="$HARNESS_TOKEN" \
  -e LAUNCH_ID=4892e570-271f-4790-a38c-b1d0a9472d07 \
  -e LEGACY_LAUNCH_ID=543008b2-337a-46e8-ae7f-4b4c55830bc7 \
  lti-harness-moodle node --input-type=module < _smoke_test/moodle-services.js
```

Exit 0; lineitems, memberships, score, result and Basic Outcomes assertions passed.
The separate creation test used `{"action":"create-lineitem","resourceLinkId":null}`
and `{"action":"score","scoreGiven":77}` against that capture, observing 201/200.

From the Moodle `codex/` command surface:

```sh
./bin/phpcs /Users/mattp/projects/LTI_test_harness/_smoke_test/moodle-fixture.php
```

PHPCS scope: **whole file**, new PHP fixture. Initial style errors were corrected;
final command passes with no errors or warnings. The final helper was copied to
`/tmp/lti-harness-fixture.php` and rerun using `docker exec` with the two synthetic
credential env variables and `/var/www/html/config.php`; it retained the same IDs.
`git diff --check` passes. No PHP application code was changed.

## Single self-review of this increment

Exactly one pass after initial real-platform validation, separate from the earlier
initial implementation's review. Corrections were validated without a second pass.

| Check | Y / N / - | Disposition |
| --- | --- | --- |
| Strict protocol defaults retained | Y | Explicit flag only; warnings in UI/API, raw claim retained |
| Explicit line-item association | Y | Validated string/null override; no hidden URL or ID remapping |
| Real correctness assertions | Y | Actual roster membership and grade result asserted; gradebook inspected |
| Fixture scope and idempotence | Y | Only named harness records; rerun preserved IDs |
| Credentials and TLS | Y | Test credentials/keys ignored, verified TLS, existing CA key not copied |
| Style / tests | Y | Whole-file PHPCS and 40 protocol tests pass |
| README completeness | Y | Capabilities, startup, use, API, HTTPS, Moodle setup and findings linked |
| Deep Linking / review / legacy URLs on real branch | N | Explicit platform failures retained; no passing claim |
| Mobile / other LMSs | - | Outside this validation pass; no Moodle WS changes |

No unresolved harness MUST FIX findings from this pass. The recorded Moodle branch
failures need project follow-up before those migration acceptance gates can pass.

## Harness/tool handoff

- Orchestrator `verify` returned **DEGRADED** with all required code/docs capabilities
  usable, but stale sitemap warning. Subsequent `query` commands succeeded while
  returning thin/drifting file results. Those results were not used as current-code
  truth; actual UI paths and directly identified source files supplied evidence.
- No Moodle wrappers failed. PHPCS initially reported genuine style issues in the
  new fixture and passed after correction; that was not a wrapper defect.
- Header forwarding, outbound port, placement enablement and proxy buffering were
  environment setup corrections detailed above. Product validation completed for
  the passing flows; the five real-platform findings remain explicit limitations.

Initial commit was pushed to `origin/feat/standalone-lti-harness` as requested. The
README, real-integration helpers, compatibility improvements and this report are
committed and pushed on the same branch. No force push or Moodle branch push.
