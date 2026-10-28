# Automation API

Set `Authorization: Bearer <HARNESS_TOKEN>` and `Accept: application/json` on every
`/api/*` request. Request bodies are JSON objects. Errors use the appropriate HTTP
status and `{"error":"message"}`. Browser session forms are available separately.
No CORS headers are enabled. `GET /health`, `GET /registration`, and the public
JWKS endpoint are unauthenticated.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/platforms` | Registered LTI 1.3 platforms |
| POST | `/api/platforms` | Register platform (201); duplicate issuer/client is 409 |
| GET | `/api/consumers` | LTI 1.1 consumers, shared secrets omitted |
| POST | `/api/consumers` | Register consumer (201), secret redacted in response |
| GET | `/api/launches` | Launches, claims, saved line item URL, action histories |
| GET | `/api/launches/{id}` | One captured launch |
| POST | `/api/launches/{id}/actions` | Execute an action |
| DELETE | `/api/launches` | Clear launches, preserving keys and registrations |

## Register

```sh
export TOOL_URL=http://localhost:8080
export HARNESS_TOKEN=your-test-token
curl --fail-with-body "$TOOL_URL/api/platforms" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test LMS","issuer":"https://lms.example.test",
       "clientId":"123","deploymentIds":["1"],
       "authUrl":"https://lms.example.test/auth",
       "tokenUrl":"https://lms.example.test/token",
       "jwksUrl":"https://lms.example.test/certs",
       "serviceOrigins":[]}'
```

Issuer/client/deployment IDs are exact strings, not numeric IDs. All URLs must be
absolute HTTP(S) URLs. Origins from issuer/auth/token/JWKS URLs are trusted by
registration; `serviceOrigins` adds other explicitly trusted service/return origins.
Never derive the issuer from the token without an existing trusted registration.

For LTI 1.1:

```json
{"name":"Legacy platform","key":"test-key","secret":"test-secret","serviceOrigins":["https://lms.example.test"]}
```

POST this object to `/api/consumers` and configure the same key and secret on the
platform. The launch URL is `/lti/launch` for both versions. Platform registrations
are intentionally immutable in v0.1; use a new client ID or reset the isolated data
volume to replace one. Do not reset the volume during stored-URL upgrade tests.

## Actions

```sh
curl --fail-with-body "$TOOL_URL/api/launches/$LAUNCH_ID/actions" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"score","scoreGiven":85}'
```

| `action` | Additional input | Behaviour |
| --- | --- | --- |
| `answer` | `answer` | Store local quiz result; no grade passback |
| `deep-link` | `content`: `echo` or `quiz`, optional `title` | Return `{url, JWT, claims}` for form POST to the platform |
| `lineitems` | Optional `pageUrl` | GET advertised AGS collection |
| `create-lineitem` | Optional `label`, `resourceLinkId` (string or `null`) | POST 100-point line item with review support, save returned `id` |
| `score` | `scoreGiven` 0–100, optional `lineitemUrl` | POST a completed/fully graded score for the launching subject |
| `results` | Optional `lineitemUrl`, `pageUrl` | GET AGS results |
| `members` | Optional `pageUrl` | GET NRPS membership container |
| `outcome` | `scoreGiven` 0–100 | LTI 1.1 Basic Outcomes `replaceResult`, normalized to 0–1 |

AGS/NRPS results contain `request`, `response` and `success`. A platform service
403 is an executed test with `success:false`, while token acquisition failure or
refused redirects return an API error. **Assert `success` as well as HTTP status.**
Headers include pagination `Link` values. Pass the chosen next URL as `pageUrl`
for a read action; it must belong to a registered origin. Pagination is deliberately
not followed automatically, so tests can assert individual responses.

`lineitemUrl` overrides the created line item URL or the launch's advertised line
item, in that order. Score/results suffixes are appended to its path while preserving
query parameters. Captured line item URLs are never relocated. An explicit override
must belong to a trusted platform origin.

Submission-review launches preserve the reviewer's `sub` and the learner's
`for_user.user_id`. Review is read-only: write actions return 403, avoiding accidental
grades for the reviewing teacher. Local learner answers are matched by platform
deployment and resource link (or line item for standalone review).

LTI callback errors return 400. State is consumed on the first callback, including
invalid ones; start a new login after a failed launch. API polling should identify
its own launch by context/resource/user or a unique custom claim. Use isolated
harness volumes per parallel CI job to avoid test data collisions.

## Stored-URL migration regression

1. On the old LMS version, launch, create a line item, and save the launch ID and
   response `id`. Confirm the score action succeeds.
2. Upgrade only the LMS, retaining the tool's `/data` volume and platform client.
3. POST the score action against the **same launch ID**, without a new launch.
4. Assert `request.url` still contains the captured legacy path/query, `success`
   is true, response is 2xx, and the LMS gradebook has the new score.
5. Repeat with an explicit old `lineitemUrl` on a new launch. A redirect is a failure.

This tool makes T-HAR/T-PATH possible; passing its synthetic regression test alone
is not evidence that a particular Moodle migration preserves stored endpoints.

Anonymous launches (no `sub`, possibly empty roles) are accepted. Sending an AGS score requires a launching subject.

For `create-lineitem`, omitting `resourceLinkId` uses the received resource ID unchanged.
Pass a non-empty string to test an explicit association, or `null` to create a
standalone column. The chosen value is visible in the request transcript.

`ALLOW_NUMERIC_RESOURCE_LINK_ID=true` is an explicit runtime compatibility option:
strict mode otherwise rejects numeric LTI 1.3 resource IDs. Accepted compatibility
launches include `warnings`; tests should assert these as protocol deviations.
