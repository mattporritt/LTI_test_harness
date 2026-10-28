# LTI 1.3 dynamic registration

The harness implements platform-initiated initial registration using the
[LTI Dynamic Registration specification](https://www.imsglobal.org/spec/lti-dr/v1p0).
Moodle discovers the tool through a one-use registration URL. The harness reads
platform discovery, submits OIDC/LTI tool metadata, and saves the assigned client,
platform endpoints and deployment. Manual registration remains available.

## Moodle browser setup

Use the running HTTPS deployment described in the [README](../README.md). Both
systems must trust each other's certificates and reach the same advertised URLs.

1. Open `PUBLIC_URL/admin` and authenticate as `admin` with `HARNESS_TOKEN`.
2. Under **Dynamic registration**, enter Moodle's exact origin in **Trusted platform
   origins**, e.g. `https://webserver`, and a distinctive **Tool name**. Origins
   include scheme/port, but no path or query. For Moodle installed at `/moodle`,
   trust the origin; discovery is separately checked against its exact issuer path.
   Add other origins only when you intentionally trust a platform that puts its
   registration/authentication/services on a separate host.
3. Click **Create registration link**. Copy the displayed URL. It expires in ten
   minutes, may register once, and is lost if the harness restarts. Treat it as a
   temporary registration capability; do not post it in shared/public artifacts.
4. In Moodle **Manage tools**, paste that URL into **Tool URL** and click
   **Add LTI Advantage**. Do not paste the tool's `/lti/launch` URL here.
5. If Moodle finds another tool on the same domain, choose **Register as a new
   external tool** for an isolated test. Updating an existing client is outside
   this feature's scope; do not select Update for an existing tool.
6. In the harness confirmation screen, check the displayed discovery URL, approved
   origins and requested configuration, then click **Register tool**.
7. Expect **Dynamic registration complete**, a client ID and **Deployment saved**.
   No manual copying of Moodle client/auth/token/JWKS values is needed.
8. Click **Return to platform**. This sends the standard close message so Moodle
   refreshes its list. Find the new **Pending** tool and click **Activate**.
9. As teacher, add an activity with this configured tool. Use **Select content**,
   choose the quiz, prepare the return, click **Return to platform**, then save.
   As learner, launch, answer and send a grade. Verify the real Moodle gradebook,
   roster and results using the [README test steps](../README.md#5-test-grading-roster-and-content-selection).

Activation and Moodle permission changes remain under the Moodle administrator's
control. The harness requests AGS read/create/score/results, NRPS, identity claims,
Deep Linking and submission review. The platform may grant fewer permissions;
launch-time claims, not the requested registration scopes, govern service actions.

If the platform returns no deployment ID, the client is saved with
`deploymentPending: true`, an empty deployment list and a **Deployment required**
form in harness administration. Copy the actual deployment ID(s) from your LMS
into that form and save before launching. Unknown deployments remain rejected;
the harness never trusts the first received deployment automatically.

## Automation

Issue the same capability using the authenticated API:

```sh
curl --fail-with-body "$PUBLIC_URL/api/registration-links" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Harness dynamic test","origins":["https://webserver"]}'
```

HTTP 201 returns `{"url":".../lti/register/<id>","expiresAt":"..."}`. Use the
returned URL in your platform's registration UI. For a protocol driver, append
`openid_configuration=<encoded discovery URL>` and optional
`registration_token=<encoded platform token>` with normal URL encoding. GET
renders confirmation and performs no outbound fetch. POST to the same path (without
query parameters) executes registration once. It returns an HTML success/error
page; read `/api/platforms` to assert the assigned client/deployment and then test a
real launch. A repeated POST returns 410 without contacting the platform.

The initiating platform token is not the harness admin token. It is sent as Bearer
only on the POST to the discovered registration endpoint, never on discovery GET.
Tokenless platforms are also supported. Origin/Sec-Fetch-Site checks apply to
browser completion requests; a browser form is expected to come from the tool's
own confirmation page. Backend drivers need not set an Origin header.

Complete a pending deployment through the authenticated API:

```sh
curl --fail-with-body "$PUBLIC_URL/api/platforms/$PLATFORM_ID/deployments" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"deploymentIds":["your-actual-deployment-id"]}'
```

This replaces the accepted deployment list. `PLATFORM_ID` is the harness record's
`id` from `/api/platforms`, not the OAuth client ID. It requires at least one
non-empty string; IDs are not guessed from counters or URLs.

## Failure handling and boundaries

- Discovery must be beneath the exact declared issuer, including any issuer path.
  Discovery, auth/token/JWKS and registration endpoints must use operator-approved
  origins. A URL with userinfo, fragments or a non-HTTP(S) scheme is refused.
- Redirects are refused, and response size/time limits use the existing outbound
  client. HTTP is permitted for isolated Docker tests; use trusted HTTPS for the
  normal browser deployment. Never disable certificate validation.
- Registration tokens stay in bounded, expiring process memory. They are excluded
  from tool pages, captured action histories and persisted platform records. They
  necessarily arrive in the platform initiation URL; protect browser history and
  reverse-proxy logs accordingly. Returned registration-access tokens are discarded.
- Consumption happens before network I/O. Expired, failed or used links cannot be
  retried. Create a new link and restart the platform flow after fixing the error.
  This avoids blindly reusing a one-time platform token after a timeout/partial result.
- A completion failure after the platform has accepted a client can require manual
  cleanup/reconciliation in the platform. There is no distributed rollback.
- This feature registers **new** clients. OIDC client-configuration GET/PUT updates,
  re-registration of an existing Moodle tool, LTI 2.0 and certification are excluded.
  `/registration` remains the public manual-endpoint JSON; it is not a dynamic
  registration initiation URL.

Automated coverage includes actual HTTP discovery/registration, requested metadata,
optional/missing tokens, issuer/path/origin checks, denied/invalid responses,
redirects, expiry, concurrency/replay, pending deployment completion, persistence,
secret exclusion and a signed launch using the newly assigned client.

[Real Moodle browser validation and exact checks](dynamic-registration-validation.md).
