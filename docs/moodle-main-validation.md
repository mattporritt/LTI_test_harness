# Current-main browser validation

28 October 2026. Fresh installation at `https://webserver` on upstream Moodle
`main`, commit `46c042e7da6` (6.0dev, Build 20261021). Harness revision `5963624`.
This is a separate run from the core_ltix development-baseline reports.

## Environment preparation

Fetched `origin main`, switched from `lti-analysis/baseline-core` to `main` and
fast-forwarded it. Existing untracked local plugins and command surfaces were
preserved; no tracked Moodle source was edited. Backed up the full PostgreSQL
database and Moodle data, reset only the site's `m_` tables and Moodle data, then
ran `./bin/install` and `./bin/web php /var/www/html/admin/cli/purge_caches.php`.
Installation completed successfully. PHPUnit/Behat databases were not reset and
no PHPUnit/Behat acceptance run is claimed.

The existing HTTPS proxy, public development CA and harness image were reused.
Moodle's allowed outbound ports are newline-separated `80`, `443`, `8444`.
TLS verification and the default blocked-host list remain enabled. The Apache
Authorization forwarding correction from the earlier report remains in this test
container. The dedicated harness container was subsequently replaced with the
same data volume and `ALLOW_NUMERIC_RESOURCE_LINK_ID=false`; a fresh learner launch
and separate teacher review succeeded with strict validation. The optional
moodle-docker service was left running; shared Moodle containers were not rebuilt.

## Browser acceptance results

Chrome was connected and returned an about:blank accessibility snapshot before
setup. Administrator, learner and teacher used separate browser contexts.

| Workflow | Observed result |
| --- | --- |
| Register tool | Administrator created LTI 1.3 tool through Moodle's real configuration form, enabling Deep Linking, AGS column management, NRPS and synthetic user details |
| LTI 1.3 learner launch | OIDC round trip completed; resource-link ID is a string; strict validation succeeds without compatibility warnings |
| Interactive activity | Learner entered 4 for 2 + 2; local result correct / 100 |
| AGS / NRPS | Browser score 83 returned 200; browser roster contained the enrolled learner, teacher and administrator; automated reads verified line items, results and membership |
| Associated line item | Browser Create line item used the received resourceLinkId unchanged and returned 201; no remapping or standalone workaround |
| Deep linking | Administrator opened Select content, chose quiz, prepared signed response and explicitly returned it to Moodle; Moodle displayed Content selected, populated the activity title and saved the new activity |
| Deep-linked learner activity | Learner launched the saved activity, answered the question and sent score 88 using the browser form |
| LTI 1.1 | Learner launched signed activity and sent 91 through Basic Outcomes; XML result reported success |
| Actual learner gradebook | Learner user report visibly displayed modern 83.00, legacy 91.00 and deep-linked quiz 88.00 |
| Submission review | Administrator and separately authenticated teacher opened the real Moodle gradeReport launch URL for the deep-linked activity; tool received LtiSubmissionReviewRequest and displayed the learner's stored answer, reviewer identity and read-only notice |
| Review write prevention | Authenticated automation against the real teacher review capture attempted a score and received 403 |
| Persistence | Captures, registrations and local learner answer survived the strict-mode container replacement |

Submission review was launched by navigating to Moodle's actual
`/mod/lti/launch.php?id=<cmid>&action=gradeReport&user=<learnerid>` URL. The user
report's Actions menu offered Grade analysis, not a review link; a gradebook review
button was not validated. Deep Linking ran in Moodle's selection iframe; resource
launches used Existing window. New-window launches, a full embedded-resource matrix,
permissions-disabled cases, Firefox, mobile, backup/restore and course copy were
not exercised in this run.

## Earlier blockers compared with main

- JSON launch-hint failures: absent for Deep Linking and submission review on main.
- Numeric resource-link ID: absent; strict string IDs verified.
- Launch/AGS resource association: associated creation succeeds (201).
- Legacy service path: current main advertises and successfully serves
  `/mod/lti/services.php/...` for scores/results. A fresh main install does not
  prove stored-URL compatibility through the future core_ltix migration. T-HAR and
  T-PATH upgrade gates remain open, as do scheduled Moodle CI integration gates.

These results do not mean the previously tested core_ltix branch was fixed.

## MDL-89973 still fails on main

Both policy assertions were rerun against the real learner launch, with each step
observed from Moodle's database, grades and completion. Both commands exited 1,
which is the expected regression signal on the unpatched LMS:

- Ignore-partial: four failed steps — pending-after-final, stale-final-after-pending,
  stale-final-after-null-clear and stale-final-after-omitted-clear.
- Accept-partial: those four plus pending-passing-score. This option asserts the
  desired policy; it does not configure an unimplemented setting in Moodle.
- Every score request returned 200. Actual grade/completion state exposed failures.
- Both runners restored grade 83 and passing completion 2. Final CLI observation
  and learner gradebook confirmed restoration. The deep-linked grade stayed 88.

## Reproduction and exact checks

Run Moodle wrappers from its `codex/` directory. Set `LTI_HARNESS_REPO` to this
repository, source its ignored local test credentials, and set `HARNESS_URL`,
`HARNESS_TOKEN` and `NODE_EXTRA_CA_CERTS` to the trusted test deployment.

```sh
# New helper uses main's mod_lti APIs, not core_ltix placement APIs.
# Create the named 1.3 tool in the browser first (Moodle setup guide).
docker cp "$LTI_HARNESS_REPO/_smoke_test/moodle-main-fixture.php" moodlemaster-webserver-1:/tmp/lti-harness-main-fixture.php
docker exec -e HARNESS_FIXTURE_PASSWORD -e HARNESS_LEGACY_SECRET moodlemaster-webserver-1 php /tmp/lti-harness-main-fixture.php /var/www/html/config.php
```

Register the returned client/deployment and displayed auth/token/JWKS URLs with
the harness. The helper creates course `LTI-HARNESS-20261028`, synthetic accounts
`harness_student_20261028` / `harness_teacher_20261028`, and two named activities.
This run used course 2, learner 3, teacher 4, modern CMID 1 and legacy CMID 2.
The browser-created deep-linked quiz is CMID 3. Local passwords are not committed.

The commands below were run with the IDs of the actual browser captures:

```sh
LAUNCH_ID=edb6f49d-91b7-4e22-9082-a72338e6b203 \
LEGACY_LAUNCH_ID=df314849-8d9b-4b42-9b18-d0530661fe75 \
node "$LTI_HARNESS_REPO/_smoke_test/moodle-services.js"
# Exit 0: line items, membership, score, result and Basic Outcomes assertions.

docker cp "$LTI_HARNESS_REPO/_smoke_test/moodle-completion.php" moodlemaster-webserver-1:/tmp/lti-harness-completion.php
docker exec moodlemaster-webserver-1 php /tmp/lti-harness-completion.php /var/www/html/config.php 1 3 --configure

LAUNCH_ID=edb6f49d-91b7-4e22-9082-a72338e6b203 \
MOODLE_CONTAINER=moodlemaster-webserver-1 MOODLE_CMID=1 MOODLE_USERID=3 \
node "$LTI_HARNESS_REPO/_smoke_test/ags-partial-scores.js"
# Exit 1: four real grading/completion regressions.
# Repeat with ACCEPT_PARTIAL_SCORES=true: exit 1, five failed expectations.

docker exec moodlemaster-webserver-1 php /tmp/lti-harness-completion.php /var/www/html/config.php 1 3
# Grade 83, completion 2.

./bin/phpcs /Users/mattp/projects/moodle/codex/_smoke_test/main-moodle-fixture.php
# Exit 0; whole-file scope for the new main fixture helper.
```

Local additional assertions (`codex/_smoke_test/main-acceptance.mjs`) passed:
strict resource ID and no warnings, teacher/learner review identities, review score
write denied with 403, associated line item created with 201, retained captures.
Raw JSON reports, browser screenshots and pre-reinstall backups are local under
`codex/_smoke_test/artifacts/main-validation/`; backups contain private local data
and are excluded from commits.

## One self-review pass

| Check | Y / N / - | Finding |
| --- | --- | --- |
| Correct branch and clean tracked Moodle tree | Y | Current upstream main; no product edits |
| Actual browser workflow, roles and gradebook | Y | Admin configuration/deep linking, learner content/grades, separate teacher review |
| Strict protocol validation | Y | Compatibility flag disabled; string IDs accepted |
| Service success vs actual state | Y | Real gradebook and DB assertions; MDL-89973 remains a failure |
| Fixture correctness | Y | MUST FIX found during setup: generator dummy resourcekey/password caused audience 12345; cleared and fixed helper |
| TLS and environment isolation | Y | Verified CA; only test-site reinstall and dedicated harness replacement |
| Migration gates and coverage claims | Y | No stored-URL upgrade, mobile or full browser matrix pass claimed |
| Moodle source lint / WS changes | - | No Moodle source or Web Services changes; helper whole-file PHPCS passed |

No unresolved harness MUST FIX finding remains. No second review pass was run.

## Harness/tool handoff

- `./bin/phpcs _smoke_test/main-moodle-fixture.php` resolved relative to the Moodle
  checkout rather than codex and reported file does not exist. The absolute-path
  command above passed; product/browser validation completed.
- Chrome screenshot filePath writes were rejected as outside its configured roots.
  Taking a JPEG without filePath and saving the returned image through the local
  filesystem tool worked; review and gradebook screenshots were retained.
- Some Chrome navigations timed out while the page subsequently became available;
  fresh snapshots and successful interactions supplied the validation evidence.
- Initial host Node request lacked the development CA and failed certificate
  validation. Setting NODE_EXTRA_CA_CERTS to the existing public CA resolved it.
- An initial comma-separated port setting blocked Moodle JWKS retrieval; corrected
  to newline-separated ports. Default host blocks were not disabled.
- The main helper initially inherited dummy generator credentials; corrected as
  above. Deep-link browser-created activities did not have that fixture mistake.
- Orchestrator verify was DEGRADED for stale sitemap; code/docs usable. The first
  query drifted to unrelated code; a bounded mod_lti query identified relevant
  files, which were checked directly. No stale site-navigation claim was used.
