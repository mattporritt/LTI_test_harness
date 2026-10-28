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
[Requirements and boundaries](docs/requirements.md) · [Validation record](docs/validation.md) · [Real Moodle results](docs/moodle-validation.md)

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
Processor. See [scope rationale](docs/requirements.md). Real Moodle 6.0dev launches, gradebook updates and roster access were verified; see
[real Moodle results](docs/moodle-validation.md) for passing flows and development-branch failures.
Mobile app and other-vendor interoperability remain unverified.


## Use the tool

1. Register the tool URLs in the LMS and enable its grade and membership permissions.
2. Register the LMS's exact issuer, client ID, deployment ID(s) and platform URLs in
   the harness `/admin` page. Register a separate key/secret pair for LTI 1.1.
3. As a teacher, add an external-tool activity. As a learner, launch it and inspect
   the verified claims. Answer the quiz, then explicitly send a grade when desired.
4. Use the service buttons to inspect line items, results and the roster, or use the
   bearer-authenticated [JSON API](docs/api.md) to assert those values in automation.
5. For content selection, enable Deep Linking on the LMS tool/placement, choose an
   item and submit the signed return to the LMS. For submission review, use an AGS
   line item declaring `submissionReview` and open its gradebook review launch.
6. Preserve `/data` when restarting the container or upgrading Moodle. Reuse the
   same launch ID to check that saved service URLs still work.

The default content is a one-question quiz. Deep Linking can instead select a
claims-only explorer. Quiz answers are local records; grade passback is a separate
operation. Service responses always show success/failure and the exact requested
URL; an HTTP 200 from the automation API alone is not proof of a successful LMS call.

## Real Moodle / Docker setup

[Step-by-step HTTPS, Docker network, field mapping and test guide](docs/moodle.md).
The guide covers pre-core `mod_lti` and the development `core_ltix` endpoint layouts,
placement activation, trusted development CAs, outbound ports, and FastCGI headers.
It includes the exact isolated setup used against `https://webserver`.

| Setting | Default / use |
| --- | --- |
| `PUBLIC_URL` | `http://localhost:8080`; externally visible tool origin, including port |
| `HARNESS_TOKEN` | Required, 16+ characters; API bearer token and admin password |
| `PORT` | `8080`; container HTTP listener |
| `DATA_DIR` | `/data` in Docker; `./data` on host |
| `NODE_EXTRA_CA_CERTS` | Optional path to public CA certificate for private HTTPS platforms |
| `ALLOW_NUMERIC_RESOURCE_LINK_ID` | `false`; explicit compatibility for nonconforming numeric IDs |

Strict LTI 1.3 validation is the default. The tested Moodle development branch emits
numeric `resource_link.id` values; set `ALLOW_NUMERIC_RESOURCE_LINK_ID=true` only
when intentionally testing that branch. The raw claim is retained and the capture
and UI carry a protocol warning. This does not turn a platform defect into a
conformance pass. Line-item creation also accepts explicit `resourceLinkId` or
`null` for a standalone column, useful when diagnosing platform association bugs.

After a browser launch, repeat the real service checks with:

```sh
HARNESS_URL=https://your-tool.example.test \
HARNESS_TOKEN=your-test-token LAUNCH_ID=your-learner-launch-id \
node _smoke_test/moodle-services.js
```

For private certificates, export `NODE_EXTRA_CA_CERTS` for this command too.
The smoke script verifies roster membership, posts a score and asserts the returned
result. Run it only on synthetic test learners: it intentionally changes grades.
The optional `CREATE_STANDALONE=true` creates and scores a separate grade column;
`LEGACY_LAUNCH_ID` additionally tests a chosen LTI 1.1 launch's Basic Outcomes return.


## moodle-docker test services

Use the [optional moodle-docker service fragment](integrations/moodle-docker/README.md)
with `bin/moodle-docker-compose -f ...`. It adds `ltimock:8080` to the selected
project network, uses a project-specific persistent volume, and exposes opt-in URL/
token environment entries to a newly created test webserver. Moodle and Selenium
reach it by Docker DNS. No shared stack teardown or wrapper source patch is needed.
For HTTPS/manual use, follow the trusted-proxy setup linked above.

## Provisional grades and completion: MDL-89973

The manual form and API can send `Pending`/`InProgress` scores, explicit null or
omitted scores, custom maxima, and older timestamps. This lets tests expose
[MDL-89973](https://moodle.atlassian.net/browse/MDL-89973), which the previous
FullyGraded-only score action could not reproduce.

The [reproduction guide](docs/MDL-89973.md) includes a real-Moodle regression runner
that checks grades and passing-grade completion after every update. On the local
development branch it confirmed that a provisional update erased a final grade and
that older updates were accepted after clearing, despite HTTP 200 responses.
The runner restores the synthetic learner's final grade after testing. It exits 1
when those regressions are present; this does not modify or claim to fix Moodle.

[Latest integration validation and commands](docs/integration-validation.md) records
the wrapper probes, 50 passing tests, and real regression results.
