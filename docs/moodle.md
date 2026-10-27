# Connecting a Moodle test site

Use an isolated development/test site and synthetic users. No Moodle modifications
are required to register this tool. Exact setting names depend on Moodle version;
use the endpoints and IDs that your installed site displays.

## Network and HTTPS

Before choosing URLs, confirm the site's actual `$CFG->wwwroot` in its `config.php`.
Use that site's hostname, not another checkout's Docker instance. The browser, tool
container and LMS container must all reach the configured origins. Host `localhost`
is not the host machine when resolved from another container.

For a container network, attach the harness container to the LMS's existing network
without changing the LMS containers. Give the harness a DNS name the host browser
can also resolve, or use a reverse proxy reachable by both. Keep `PUBLIC_URL` equal
to the URL entered in Moodle; don't use separate internal and external tool URLs.
HTTP examples in the README are for standalone local tests. An HTTPS Moodle page
needs an HTTPS tool endpoint to avoid blocked mixed content. Terminate TLS at a
local proxy and forward to port 8080. Internal platform certificates must be trusted
inside the harness; mount a public CA and set `NODE_EXTRA_CA_CERTS` if needed.

Do not turn off TLS verification or restart/reconfigure a shared LMS stack to test
the tool. Its Compose file starts only the harness and its dedicated volume.

## LTI 1.3 manual registration

1. Start the harness. Open its `/admin` page and copy its tool URLs.
2. In Moodle's site external-tool management, add a manually configured LTI 1.3 tool.
   Set tool URL and content-selection URL to `PUBLIC_URL/lti/launch`, initiate-login
   URL to `PUBLIC_URL/lti/login`, redirect URI to `PUBLIC_URL/lti/launch`, and public
   keyset URL to `PUBLIC_URL/.well-known/jwks.json`.
3. Enable Deep Linking/content selection, grade service access and membership access
   as required by your test. Enable the configured tool for course use.
4. Save, then copy Moodle's platform issuer, client ID, deployment ID, authentication
   request URL, access-token URL and public-keyset URL into the harness registration
   form. Do not guess whether endpoints are under `/mod/lti/` or `/ltix/`.
5. As a teacher, add an External Tool activity using this configured tool. Choose
   content when testing Deep Linking; click the harness's explicit return button.
6. As a student, open the activity, inspect claims, answer the question and send a
   score. Confirm that student's grade in Moodle. Read roster and line items with
   permissions enabled, then test again with relevant permissions disabled.
7. For submission review, create a line item with the harness (or select content
   through Deep Linking); it advertises the tool's submission-review launch URI.
   If the installed platform supports the extension, open review from the grade report. Check `for_user` and the local answer history. The harness does not add a
   Moodle-specific review button and does not add a vendor-specific review workflow.

## LTI 1.1

Register a key/shared-secret pair on the harness `/admin` page. In Moodle create an
LTI 1.1 tool using the same pair and `PUBLIC_URL/lti/launch`. Enable grade acceptance.
Add the Moodle origin to the consumer's trusted outcome-service origins. Launch as
a student, send an outcome score, and check that student's gradebook result. Bad
signatures and replayed OAuth nonces must be rejected.

## Moodle CI and mobile

Keep the tool optional: set a URL and token only in jobs intended to run external
LTI integration tests, and skip those tests explicitly when not configured. Use
isolated tool volumes per job. A PHPUnit HTTP client can read `/api/launches` and
invoke actions; Behat can interact with the visible forms after an LMS launch.
Use a unique custom launch marker to correlate an individual test's capture.
Do not put credentials in source or public CI artifacts.

This release's own CI proves tool protocol behaviour against a synthetic platform.
Moodle's opt-in PHPUnit/Behat tests, regression across the LTI migration slices,
upgrade fixtures and app launch-path coverage must be connected and run in the
Moodle repository. No mobile Web Services are added or changed by this tool.
