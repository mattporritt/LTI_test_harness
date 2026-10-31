# Platform mode (the harness as an LTI consumer)

By default the harness is an LTI **tool**: a platform such as Moodle launches it.
Platform mode reverses the roles. The harness acts as the LTI 1.3 **platform** (the
LMS, also called the consumer) and launches a tool that you are testing, for example
Moodle's own tool-side support (`enrol_lti` and `auth_lti`).

Use it to test a tool's launch handling, account provisioning and linking, and Deep
Linking behaviour with controlled, repeatable launch data and no real LMS.

## What it implements

| Area | Support |
| --- | --- |
| Messages | `LtiResourceLinkRequest`, `LtiDeepLinkingRequest` |
| OIDC | Third-party initiated login (POST or GET), authentication endpoint with `form_post`, one-use `state`/`nonce` handling |
| Signing | RS256 using the harness keyset, published at `/platform/jwks.json` |
| Claims | Standard LTI claims, configurable user, roles, context, resource link, custom parameters and arbitrary claim overrides or removals |
| Deep Linking | Settings sent to the tool; the tool's signed response is verified against its public keyset and the content items are recorded |
| Negative tests | An optional invalid signature, claim removal and override |
| Not implemented | Platform services (AGS, NRPS), Basic Outcomes, dynamic registration initiated by the harness, submission review messages |

## Platform details to give the tool

`GET /api/platform` (authenticated) returns these values. All are derived from `PUBLIC_URL`.

| Tool field | Value |
| --- | --- |
| Platform ID (issuer) | `PUBLIC_URL` |
| Authentication request URL | `PUBLIC_URL/platform/auth` |
| Public keyset URL | `PUBLIC_URL/platform/jwks.json` |
| Access token URL | `PUBLIC_URL/platform/token` (returns 501; services are not implemented) |

`PUBLIC_URL` must be reachable from the **tool** (to fetch the keyset) and from the
**browser** that performs launches. In moodle-docker, give the harness container a
Docker network alias for a hostname that also resolves to the host's loopback address
(for example a `*.127.0.0.1.nip.io` name) and publish its port on host loopback.

## Register a tool

Register the tool in the harness with `POST /api/platform/tools` or in `/admin`:

| Field | Meaning |
| --- | --- |
| `name` | Display name |
| `loginUrl` | The tool's OIDC login initiation URL |
| `redirectUris` | The tool's redirect URIs (comma separated or an array); authentication requests must match one exactly |
| `targetLinkUri` | Default resource link target (default: first redirect URI) |
| `deepLinkUrl` | Default Deep Linking target (default: `targetLinkUri`) |
| `jwksUrl` | The tool's public keyset, needed only to verify Deep Linking responses |
| `clientId` | Client ID shared with the tool (generated when omitted) |
| `deploymentId` | Deployment ID shared with the tool (default `1`) |
| `loginMethod` | `POST` (default) or `GET` for login initiation |
| `serviceOrigins` | Additional trusted origins for outbound requests |

Outbound requests (currently only fetching the tool keyset) are limited to origins
derived from the registered URLs and `serviceOrigins`, like the rest of the harness.
Register the same issuer, client ID and deployment ID in the tool.

## Launch

`POST /api/platform/launches` creates a launch and returns a `launchUrl`:

```json
{
  "toolId": "<tool id>",
  "messageType": "LtiResourceLinkRequest",
  "user": {"sub": "user-1", "name": "Ada Lovelace", "given_name": "Ada",
           "family_name": "Lovelace", "email": "ada@example.invalid",
           "roles": ["Instructor"]},
  "context": {"id": "course-1", "label": "C101", "title": "Course"},
  "resourceLink": {"id": "resource-1", "title": "Activity"},
  "custom": {"marker": "value"},
  "claims": {"https://example.test/claim": {"x": 1}, "name": null},
  "deepLinking": {"accept_multiple": true},
  "documentTarget": "window",
  "signature": "valid"
}
```

Only `toolId` is required. Roles may be full role URIs or `Learner`, `Instructor`,
`ContentDeveloper`, `Mentor` or `Administrator`. Defaults are a `Learner` for resource
links and an `Instructor` for Deep Linking. In `claims`, a `null` value removes a claim.
`signature: "invalid"` signs with an unrelated key.

Open `launchUrl` in a browser session for the intended user. The sequence is:

1. The harness starts OIDC login by posting to the tool's login initiation URL.
2. The tool redirects to `/platform/auth`. The harness checks the client, redirect
   URI, `login_hint` and `lti_message_hint`, then returns a signed `id_token`.
3. The tool completes the launch.

A launch is single-use and expires after ten minutes. A reused or expired launch is
refused. `GET /api/platform/launches/{id}` returns its status (`created`, `initiated`,
`token-issued`, `deep-linking-verified`), the exact claims that were issued, and any
Deep Linking result or return messages.

## Deep Linking

The tool posts its signed `LtiDeepLinkingResponse` to the `deep_link_return_url` in
the launch settings. The harness verifies the signature against `jwksUrl`, the issuer
(the client ID), audience, message type, deployment and echoed `data`, then records
the content items. Each launch accepts one response.

## Other endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/platform/tools` | Registered tools |
| DELETE | `/api/platform/tools/{id}` | Remove a tool and its launches |
| GET | `/api/platform/launches` | All platform launches |
| DELETE | `/api/platform/launches` | Clear platform launches |
| GET | `/platform/return/{id}` | Return URL; records `lti_msg`, `lti_errormsg` and related messages |

All `/api/*` routes need `Authorization: Bearer <HARNESS_TOKEN>`. The `/platform/*`
endpoints used by browsers and tools are unauthenticated and protected by the
unguessable, single-use launch identifier.

## Example: Moodle as the tool

Moodle's tool side needs `enrol_lti` and `auth_lti` enabled. Its endpoints, relative
to the site URL, are:

| Purpose | Path |
| --- | --- |
| OIDC login initiation | `/enrol/lti/login.php` |
| Redirect URIs / launch targets | `/enrol/lti/launch.php`, `/enrol/lti/launch_deeplink.php` |
| Public keyset | `/enrol/lti/jwks.php` |
| Register a platform | `/admin/enrol/lti/register_platform.php?action=add` |

### Run the harness next to a moodle-docker site

Build the image, then start it on the Moodle instance's network. The hostname must
resolve to the harness inside Docker (network alias) and to the host's loopback
address in your browser (`*.127.0.0.1.nip.io`). Use a free host port, and set `PORT`
to the same value so the registered origin is identical from both sides:

```sh
docker build -t lti-test-harness:platform .
docker run -d --name lti-harness-platform --network YOUR_MOODLE_NETWORK \
  --network-alias lti-platform.127.0.0.1.nip.io -p 127.0.0.1:8081:8081 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e PORT=8081 -e PUBLIC_URL=http://lti-platform.127.0.0.1.nip.io:8081 \
  -e HARNESS_TOKEN="$(openssl rand -hex 24)" \
  -e NODE_EXTRA_CA_CERTS=/tls/ca.pem -v /path/to/public-dev-ca.pem:/tls/ca.pem:ro \
  -v lti-harness-platform-data:/data lti-test-harness:platform
```

The CA mount is needed only to let the harness fetch an HTTPS Moodle's keyset for
Deep Linking verification. Use the public CA certificate only.

### Connect the two sides

1. In Moodle, enable `enrol_lti` and `auth_lti`. Add the harness port to
   **cURL allowed ports** (one per line, keeping existing entries). Confirm the harness
   address is not covered by Moodle's blocked-hosts list.
2. Register the harness as a platform in Moodle with the issuer, authentication URL,
   keyset URL and access token URL from `GET /api/platform`, plus a client ID of your
   choice. Add a deployment with the deployment ID you will use.
3. Register Moodle as a tool in the harness (`POST /api/platform/tools`) using the
   paths above, the same client ID and the same deployment ID. List both
   `launch.php` and `launch_deeplink.php` as redirect URIs, set `targetLinkUri` to
   `launch.php`, `deepLinkUrl` to `launch_deeplink.php` and `jwksUrl` to `jwks.php`.
4. Create a launch and open its `launchUrl` in a browser.

### Resource link launches

Moodle identifies the published tool through the `custom` claim `id`, which holds the
published tool's UUID, so create the launch with `"custom": {"id": "<tool uuid>"}` and
keep the tool's `targetLinkUri` as the plain `launch.php` URL (Moodle's login endpoint
accepts only the plain endpoint URLs). The launch's user is provisioned according to the
published tool's provisioning mode.

### Deep Linking launches

A Deep Linking launch needs only the registration and deployment. An instructor with no
linked account is sent to Moodle's account page; log in with the Moodle account to link,
then continue to the published-content page. Submitting a selection posts Moodle's
signed response to the harness, which verifies it and records the content items.

An HTTPS Moodle posts that response to the harness's `PUBLIC_URL`. If it is plain HTTP,
Chrome shows a "Form is not secure" interstitial; use an HTTPS `PUBLIC_URL` (see the
README's HTTPS setup) or, for a throwaway local run, choose **Send anyway**.

## Validation record

Exercised against upstream Moodle `main` (commit `0580991`) with the harness above:

| Check | Result |
| --- | --- |
| OIDC login initiation, authentication and signed `id_token` accepted by Moodle | Passed |
| Deep Linking launch, account linking page, relaunch of a linked platform user | Passed |
| Resource link launch for a learner provisioned automatically, landing on the published activity | Passed |
| Deep Linking selection returned to the harness, signature verified against Moodle's keyset, content item recorded | Passed |

Not yet covered: resource link launches for instructors who are prompted to link or
create an account, and a Deep Linking response over HTTPS. Platform services (AGS, NRPS)
are not implemented.
