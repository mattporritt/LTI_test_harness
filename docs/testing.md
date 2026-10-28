# Reproducible testing instructions

## Automated checks

1. Install Node.js 22+ and Docker. No npm install is necessary.
2. Run `npm run check` and `npm test`. Expect all protocol/HTTP integration tests to
   pass, including rejection paths and stored legacy URLs after process restart.
3. Run `docker build -t lti-test-harness:local .`.
4. Start with the README Compose instructions. `docker compose ps` should eventually
   report healthy. Open `/health`; expect `{"status":"ok","version":"0.1.0"}`.
5. Restart the service without removing its volume. Expect the same public JWKS,
   registrations, launch captures and saved line item IDs. Missing/short
   `HARNESS_TOKEN` must prevent startup. The image runs as the `node` user.

## Isolated manual/browser smoke (no LMS required)

The smoke fixture is intentionally under `/_smoke_test`. On Docker Desktop:

```sh
docker run -d --name lti-harness-validation \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8089:8080 \
  -e PUBLIC_URL=http://localhost:8089 \
  -e HARNESS_TOKEN=browser-validation-token \
  -v lti-harness-validation-data:/data lti-test-harness:local
node _smoke_test/platform.js
```

The fixture binds port 8092 and is a **synthetic platform**, not part of the tool
image. Linux Docker needs a host gateway mapping for `host.docker.internal`.
Keep it isolated to your local development machine. Use an empty dedicated volume
on the first run; the registration is immutable and subsequent runs reuse it.

1. Open `http://localhost:8092/`. It displays the exact platform registration values.
2. Open `http://localhost:8089/admin`, sign in as `admin` with
   `browser-validation-token`, enter those values and click **Register platform**.
   Expect the saved platform in Registrations. Submitting it twice should fail 409.
3. From the synthetic platform page choose **LtiResourceLinkRequest**, then the
   explicit **Return to platform** button. Expect the verified launch inspector.
4. Enter 4 and click **Check answer**; expect `correct:true, score:100`. Enter 3;
   expect a local incorrect result. No platform grade is sent by this action.
5. Send a score of 80; expect a scoped request to the exact `services.php/.../scores`
   path and `success:true`, HTTP 204. Try 101; expect a visible 400 error.
6. Open the launch's original `/session/{id}` URL again. Read roster, line items and
   results; create a line item. Expect captures with methods, exact URLs and status.
7. Choose **LtiDeepLinkingRequest** on the platform page, complete the launch, select
   **One-question quiz**, edit the title and prepare the return. Click **Return to
   platform**. Expect **Deep Linking return verified**, preserved `browser-data`,
   title, `harness_content:quiz` and the correct deployment.
8. Choose **LtiSubmissionReviewRequest**. Expect synthetic-user's answer history,
   reviewer synthetic-teacher, and a read-only page without score/answer controls.
9. Choose **invalid-signature**. Complete the callback; expect a visible signature
   error and no recorded successful launch. Reposting a completed callback must fail.
10. Inspect keyboard focus on labels, content selector and buttons; labels must be
    announced and focus visible. Check the error and action-result announcements.
    Confirm controls fit a narrow viewport and details can be expanded by keyboard.

Stop the fixture with Ctrl-C. Remove only the named validation container with
`docker rm -f lti-harness-validation`. Remove its named volume separately only if
an intentional reset is wanted. Don't remove any shared Moodle resources.

## Real Moodle acceptance (separate integration run)

Follow [Moodle setup](moodle.md), then repeat launches as teacher and student, both
embedded and in a new window. Test Deep Linking, AGS/NRPS enabled/disabled, Basic
Outcomes, submission review, stored URLs after upgrade, backup/restore/course copy,
and the Moodle mobile app launch path. Confirm actual gradebook updates, not just
HTTP responses. Record the exact Moodle version and deployment configuration.
A real Moodle 6.0dev pass is recorded in [Moodle validation](moodle-validation.md), with successful grade/roster checks and specific development-branch failures. Mobile remains unverified.
