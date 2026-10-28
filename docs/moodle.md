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

## Main versus the LTI development branch

The [current-main browser validation](moodle-main-validation.md) records a fresh
Moodle install with working Deep Linking and teacher submission review. Its helper,
`_smoke_test/moodle-main-fixture.php`, uses main's `mod_lti` APIs and leaves generated
activity consumer credentials empty so configured tool credentials are used.
The original `moodle-fixture.php` targets the separate `core_ltix` development
branch and its placement APIs; do not use that helper on upstream main.
Moodle's allowed outbound-port setting uses one port per line.

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


## Verified local setup: Moodle Docker and HTTPS

The real validation used Moodle 6.0dev on `https://webserver`, network
`moodlemaster_default`. Adapt container/network names to your actual checkout.
The existing site was already installed; no reinstall or database reset was needed.
The commands below create only two additional containers and a dedicated tool volume.

1. Put `tool.crt` and `tool.key` for `lti-harness.127.0.0.1.nip.io` in the ignored
   `_smoke_test/artifacts/moodle/` directory. Sign using your existing trusted local
   development CA, or use a certificate from your normal development proxy. The
   browser and Moodle container must trust that CA. Keep private keys uncommitted.
2. Set `MOODLE_DEV_CA` to the absolute **public** CA certificate file on the host.
   Replace the example token below with a random test token.
3. Build and run:

```sh
docker build -t lti-test-harness:local .
docker run -d --name lti-harness-moodle --network moodlemaster_default \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e PUBLIC_URL=https://lti-harness.127.0.0.1.nip.io:8444 \
  -e HARNESS_TOKEN=replace-with-your-test-token \
  -e NODE_EXTRA_CA_CERTS=/tls/ca.pem \
  -v "$MOODLE_DEV_CA:/tls/ca.pem:ro" \
  -v lti-harness-moodle-data:/data lti-test-harness:local

docker run -d --name lti-harness-moodle-tls --network moodlemaster_default \
  --network-alias lti-harness.127.0.0.1.nip.io -p 127.0.0.1:8444:8444 \
  -v "$PWD/_smoke_test/nginx-moodle.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/_smoke_test/artifacts/moodle:/tls:ro" nginx:alpine
```

The public loopback hostname resolves to the host in the browser and to the proxy
through its Docker alias inside the Moodle network. This avoids host-file edits.
DNS/network policy must permit the loopback hostname; another trusted development
hostname with equivalent routing works too. Both parties use the same tool origin.
The proxy sample includes a 32KB header buffer because real Moodle OIDC hints can
exceed Nginx's default buffer and otherwise produce `upstream sent too big header`.
After replacing the tool container, reload this dedicated proxy to refresh its DNS:
`docker exec lti-harness-moodle-tls nginx -s reload`.

4. In Moodle HTTP security settings, add **8444** to allowed cURL ports, preserving
   existing entries. Verify `/health` using Moodle's own `curl` class before registration.
5. If this is the tested `core_ltix` development branch, additionally pass
   `-e ALLOW_NUMERIC_RESOURCE_LINK_ID=true` to the tool container. Stock consumers
   emitting string resource IDs do not need this option.
6. Register the tool and enable the activity placement. On this development branch,
   set placement `default_usage=enabled` and its `deep_linking_url` to `/lti/launch`
   at the tool's public origin. A selected but disabled placement cannot create links.
7. Moodle's configuration details provide the client/deployment IDs. For the tested
   branch, the issuer is `https://webserver` and endpoints are `/ltix/auth.php`,
   `/ltix/token.php`, `/ltix/certs.php`. In pre-core Moodle they are commonly under
   `/mod/lti/`; copy your site's displayed values rather than assuming either layout.
8. Enable AGS **grade sync and column management**, NRPS, and grade acceptance.
   For the tested development branch, these correspond to
   `ltixservice_gradesynchronization=2` and `ltixservice_memberships=1`.

### Apache / PHP-FPM authentication

The tested HTTP/2 development container had no Authorization-header forwarding to
PHP-FPM. Token requests succeeded but every service request returned 401. The
minimal environment correction was this Apache configuration, followed by
`apachectl graceful` inside that test container:

```apache
SetEnvIfNoCase Authorization "(.+)" HTTP_AUTHORIZATION=$1
```

Only add this if your deployment drops the header. It is an environment setting,
not a Moodle or harness source patch. Existing Docker-mounted Apache configuration
should carry the equivalent directive if it must survive container recreation.
Never work around this by disabling token validation.

### Optional core_ltix development fixtures

`_smoke_test/moodle-fixture.php` targets the tested **core_ltix development branch**.
It requires an already registered tool named `Harness real Moodle 1.3`. Copy it to
`/tmp` in the Moodle container, set `HARNESS_FIXTURE_PASSWORD` and
`HARNESS_LEGACY_SECRET`, and invoke it with the explicit root `config.php` path.
It creates/reuses only its named course, two synthetic users, legacy tool and two
activities; it enables the dedicated activity placements and Deep Linking URL.
It reports client/deployment IDs and platform endpoints. It does not install Moodle,
change existing users' passwords, or delete fixture data. Check its fixed names
before running on any shared test site. Use the normal Moodle UI on stock releases.

## Current development-branch findings

See [real Moodle validation](moodle-validation.md). Real grades and roster access
pass after environment setup. This particular branch has independent Deep Linking,
submission-review, resource-association and legacy-URL failures. Do not claim those
flows pass merely because the synthetic platform suite passes.
