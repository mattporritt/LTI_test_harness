# LTI test harness

A standalone LTI **tool** for automated platform regression tests and manual development.
One Docker image provides basic launches and advanced content-selection, grading,
roster and submission-review workflows. No Moodle code, database server, npm packages,
or external identity provider is required.

## Start

```sh
cp .env.example .env
# Edit .env: choose a random HARNESS_TOKEN (16+ characters) and the tool's PUBLIC_URL.
docker compose up --build -d
```

Open `http://localhost:8080/admin`. Sign in with user `admin` and your `HARNESS_TOKEN`.
Register your platform using its issuer, client ID, deployment ID(s), authentication,
token and public-keyset URLs. Copy the displayed tool endpoints into the platform.

`PUBLIC_URL` must be the **same origin reachable by both the browser and the LMS**.
`localhost` works for a browser but means the LMS container itself inside Docker.
For Moodle Docker, attach the tool to a reachable network or route through a common
host/reverse proxy; see [Moodle setup](docs/moodle.md). Use HTTPS when embedding in
an HTTPS LMS. The server must remain at the origin root (no URL path prefix).

To build and run without Compose:

```sh
docker build -t lti-test-harness:local .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e PUBLIC_URL=http://localhost:8080 \
  -e HARNESS_TOKEN=replace-with-your-random-token \
  -v lti-tool-data:/data lti-test-harness:local
```

## Capabilities

| Feature | Coverage |
| --- | --- |
| LTI 1.1 | HMAC-SHA1 basic launches, claim echo, interactive content, signed Basic Outcomes grade return |
| LTI 1.3 | OIDC login, RS256 JWT verification, issuer/client/deployment/target checks, one-use state/nonce |
| Deep Linking 2.0 | Signed single-resource response, preserved `data`, custom content marker, grade line item |
| AGS 2.0 | Read/create line items, send scores, read results, scoped client-credentials assertions |
| NRPS 2.0 | Read membership container; pagination via API `pageUrl` |
| Submission Review | Preserve `for_user`, show matching local learner answers, read-only review view |
| Regression evidence | Persist verified claims, exact stored service URLs and service transcripts across restarts |
| Manual / automation | Accessible server-rendered forms plus authenticated JSON API |

[API contract and examples](docs/api.md) · [Testing instructions](docs/testing.md) ·
[Requirements and boundaries](docs/requirements.md) · [Validation record](docs/validation.md)

## Develop

Node.js 22 or newer; no install step is needed.

```sh
npm run check
npm test
HARNESS_TOKEN=local-development-token PUBLIC_URL=http://localhost:8080 npm start
```

The tests run against an independent synthetic platform with real RSA signatures,
OAuth requests and HTTP services. They exercise accepted and rejected launches,
service errors and stored legacy URLs after restart. CI runs the suite and builds and
smoke-tests the image on pushes, pull requests, manual runs and weekly schedules.
The workflow is supplied; no remote CI run or registry publication is implied.

## Operations and boundaries

The named `/data` volume contains signing keys, registrations, launch claims and
captured test data. Keep it across container replacements. Use **one process / replica
per volume**. Atomic JSON snapshots suit local and CI workloads, not a shared production
service. Latest 500 launches and latest 100 actions per launch are retained.
`DELETE /api/launches` clears captured launches without changing keys or registrations.
Remove the volume only when intentionally resetting the whole tool.

Management routes require a bearer token or HTTP Basic `admin:HARNESS_TOKEN`.
Opaque session URLs are launch capabilities: anyone holding one can inspect and act
on that launch. Do not put real learners or production secrets in the harness. Protect
network access and use HTTPS outside loopback. Browser forms enforce same-origin
checks. Outbound requests are limited to registered origins; local/private origins
are intentionally permitted for Docker test networks. Redirects are never followed.
For private CAs, mount the public CA certificate and set `NODE_EXTRA_CA_CERTS`; do not
disable TLS verification. Never mount production credentials or Docker's socket.

This release targets the workplan's basic and advanced harness milestones. It is
**not 1EdTech certified** and does not implement LTI 2.0 registration, dynamic
registration, legacy Content-Item selection, Tool Settings, full AGS CRUD, or Asset
Processor. See [scope rationale](docs/requirements.md). Real Moodle, mobile app and
other-vendor interoperability passes remain separate integration checks.
