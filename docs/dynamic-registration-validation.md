# Dynamic registration validation

29 October 2026 (Australia/Melbourne). Real site `https://webserver`, upstream Moodle
main `46c042e7da6`, release 6.0dev (Build 20261021). No Moodle source changes,
reinstallation, shared-stack restart or PHPUnit/Behat database reset was needed.
The existing dedicated HTTPS harness was rebuilt with its data volume preserved.

## Automated validation

Exact commands, from the harness repository:

```sh
npm run check
npm test
docker build -t lti-test-harness:local .
docker run --rm --entrypoint node -v "$PWD/test:/app/test:ro" lti-test-harness:local --test
git diff --check
```

Source syntax checks pass; all **67 tests** pass on the host and in the final Docker
image. This includes 17 dynamic-registration cases plus the existing 50 tests.
The independent HTTP platform asserts actual request metadata/Authorization and
returns a new client/deployment. A real signed JWT launch then uses that client.
Coverage includes tokenless initiation, no secret persistence, scope reduction,
issuer origin/path checks (including path-boundary rejection), query preservation,
redirects, unsupported discovery, denied/malformed responses, single-use concurrent
completion, expiry, missing deployment rejection, authenticated deployment completion
and persisted platform state. Manual registration tests remain unchanged and pass.

## Browser workflow on real Moodle

Native Chrome was controlled through computer-use accessibility and screenshot APIs.
Only the new test tool/activity and the enrolled synthetic learner were used.

1. An authenticated harness API request created a one-use registration link scoped
   to `https://webserver`, named **Harness dynamic browser test**.
2. Administrator opened Moodle Manage tools, pasted the link into Tool URL and
   clicked **Add LTI Advantage**. Because tools already existed on the same domain,
   selected **Register as a new external tool**, preserving the existing clients.
3. The harness confirmation rendered inside Moodle's registration iframe. Clicked
   **Register tool**. The server discovered real Moodle endpoints and POSTed its
   metadata with Moodle's registration token. The completion page confirmed the
   assigned client/deployment; neither was copied manually into the harness.
4. Clicked **Return to platform**. The standard close message worked: Moodle
   refreshed its list and displayed the new tool **Pending**. Clicked **Activate**,
   then observed **Active**.
5. Added an External tool activity using that type. **Select content** launched a
   verified LtiDeepLinkingRequest with the new client/deployment. Selected a quiz,
   prepared the signed return, clicked **Return to platform**, and observed Moodle
   **Content selected** with its populated title. Saved the activity.
6. Signed out as administrator, signed in as the separately enrolled synthetic
   student, and opened the new activity. Its default embedded launch rendered the
   harness inside Moodle; strict resource-ID validation remained enabled.
7. Entered answer 4, observed local correct/100, then submitted FullyGraded score 87
   with maximum 100. The service transcript showed the actual Moodle score URL,
   student user ID and successful response.
8. Opened the student's Moodle User report. **Dynamic registration browser quiz**
   visibly displayed **87.00**. Captured a screenshot through the browser tool.

Retained fixture: course 2, tool/deployment 7, course-module 17, student 3. Its
launch capture is `a453270d-af5d-4fad-87a5-2983ea385be8`. No live initiation URL or
registration token is included in this report. These are dedicated synthetic data;
existing tools, courses and grades were left intact.

The management link was issued through the API in this run; the equivalent admin
form is documented, but a separate manual browser pass of that form is not claimed.
Submission review and LTI 1.1 were covered in the prior main validation, not repeated
for this feature. Other LMSs, Firefox, mobile and registration updates were not
validated or claimed. No certification claim is made.

## Real service assertions

With the local test deployment's URL/token and public CA exported:

```sh
HARNESS_URL="$PUBLIC_URL" \
LAUNCH_ID=a453270d-af5d-4fad-87a5-2983ea385be8 TEST_SCORE=87 \
node _smoke_test/moodle-services.js
```

Exit 0: AGS line items, NRPS learner membership, grade POST and returned result 87
all asserted. The requests used `/mod/lti/services.php/...` with `type_id=7` where
advertised; no endpoint rewriting or ID-remapping workaround. Local JSON evidence
is under the Moodle command surface's `_smoke_test/artifacts/dynamic-registration/`.
Credentials, ephemeral URLs and raw runtime artifacts are not committed.

## Single self-review

Exactly one review pass after initial implementation/browser validation. Corrections
were followed by affected tests; no second review pass was performed.

| Check | Y / N / - | Finding / disposition |
| --- | --- | --- |
| Standard initial discovery / registration / activation | Y | Real Moodle iframe, close message, Pending → Active and learner flow completed |
| Non-default tool ports | Y | Runtime MUST FIX: metadata domain omitted :8444 and Moodle returned domain_targetlinkuri_mismatch; use host including port, with an independent request assertion |
| Discovery trust and issuer boundary | Y | Approved origins, exact issuer path, no redirects, bounded outbound client |
| Token exposure and one-use handling | Y | Registration token only sent to registration endpoint; not persisted/rendered; concurrency consumed before await |
| Expiry cleanup | Y | SHOULD FIX: discard an expired ticket when accessed, not only on new issuance; fixed |
| Failed-flow UI | Y | SHOULD FIX: provide the standard Return to platform control on errors too; fixed and covered |
| Missing deployment | Y | No first-launch trust; signed launch rejected until authenticated completion |
| Real correctness evidence | Y | Learner gradebook 87.00 plus asserted results and membership |
| Scope and documentation | Y | New clients only; pending deployment, errors, no rollback and tokenless platforms documented |
| Moodle PHPCS / mobile WS changes | - | No PHP or Moodle source changes; PHPCS scope not applicable |

No unresolved MUST FIX finding remains. Existing captures and platform registrations
were retained across dedicated tool-container replacements; unused initiation links
are deliberately not retained across restarts.

## Harness/tool handoff

- Chrome DevTools MCP failed with `browser is already running ... Use --isolated`.
  Firefox DevTools failed with `Navigation to "about:home" is not allowed`.
  The in-app browser was unavailable. Native Chrome through the computer-use app
  connection worked and completed the real UI sequence; no user's browser was killed.
- Native accessibility clicks on a selector inside the content iframe did not
  change it initially. A fresh screenshot and coordinate click opened the actual
  selector; selection, submission and signed return were then observed. Native
  keyboard input was used when the numeric score setter cleared the field.
- Initial real registration returned HTTP 400. The non-secret metadata was tested
  with Moodle's registration_to_config validator through direct Docker CLI; it
  identified domain_targetlinkuri_mismatch. Corrected host/port metadata, rebuilt
  the tool and restarted the registration with a fresh one-use link; final flow passed.
- Orchestrator verify returned DEGRADED only for stale site-navigation data; code
  and docs were usable. Its bounded query identified LTI registration UI files;
  actual current registration helpers supplied the metadata validation details.
- No Moodle wrapper failed and no product code patch was required. MDL-89973 is
  unrelated and is not fixed or rerun by this increment.
