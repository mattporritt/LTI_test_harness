# LTI test harness

A standalone Docker-based LTI **tool** for testing a running Moodle LMS or another
LTI platform. It provides a browser UI and an authenticated automation API for
launches, content selection, quiz interaction, grading, rosters and submission review.
The harness needs no separate database or npm dependencies. Moodle runs separately.

## What you need

- Docker with Docker Compose. Node.js 22+ is needed only for host-side scripts or development.
- A running **development/test** Moodle site, its administrator login, and a course
  with an enrolled teacher and synthetic student. You do not need to reinstall Moodle.
- A tool URL reachable from both Moodle and your browser. The harness must also be
  able to reach Moodle's configured site URL (`$CFG->wwwroot`).
- For an HTTPS Moodle site: an HTTPS tool URL and certificates trusted by the
  browser, Moodle and harness. The harness itself listens on HTTP behind a proxy.

## 1. Start the harness

```sh
git clone https://github.com/mattporritt/LTI_test_harness.git
cd LTI_test_harness
cp .env.example .env
openssl rand -hex 32
```

Copy the generated value into `HARNESS_TOKEN` in `.env`. It is the harness admin
password and API token, **not** a Moodle password or LTI client ID. Choose one setup:

| Your environment | Setup |
| --- | --- |
| Checking the harness by itself | Use the local Compose command below |
| HTTPS Moodle in Docker, including `https://webserver` | Use the HTTPS example below, or route through your existing trusted development proxy |
| Container-only HTTP PHPUnit/Behat environment | Use the [moodle-docker service fragment](integrations/moodle-docker/README.md); its default `ltimock` hostname is not reachable from a host browser |
| Moodle on another server | Deploy the harness behind an HTTPS proxy reachable from that server and your browser; use that public origin as `PUBLIC_URL` |

### Local Compose startup

```sh
# In .env, set HARNESS_TOKEN and PUBLIC_URL before starting.
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8080/health
```

Expect `{"status":"ok","version":"0.1.0"}`. Open
`http://localhost:8080/admin`; sign in with username `admin` and your `HARNESS_TOKEN`.
This confirms the standalone tool is running. To connect Moodle, continue below
with a URL it can reach. Compose binds port 8080 to host loopback by default.

`PUBLIC_URL` is the **tool's public origin**, including any port, with no path prefix:
for example `https://lti-harness.127.0.0.1.nip.io:8444`. It is not Moodle's URL.
Set it before starting the container and use the same origin in every tool field.
Setting an HTTPS `PUBLIC_URL` does not create a certificate or enable TLS by itself.

Do not enter `http://localhost:8080` for a Docker-hosted Moodle site: inside its
container, `localhost` means Moodle's own container. An HTTPS Moodle page also
cannot embed an HTTP tool because browsers block mixed content.

### Example: an existing HTTPS moodle-docker site

This example adds only a tool container, a dedicated proxy and a data volume to the
running Moodle network. It matches the setup used for the real browser tests.
If you already run a trusted proxy, you can instead route it to harness port 8080.

Find the network of **your** Moodle webserver container:

```sh
docker ps --format '{{.Names}}'
docker inspect YOUR_MOODLE_WEBSERVER --format '{{json .NetworkSettings.Networks}}'
```

From the harness repository, set the network and **public** development CA path:

```sh
export MOODLE_DOCKER_NETWORK=your_moodle_network
export MOODLE_DEV_CA=/absolute/path/to/your/public-development-ca.pem
export PUBLIC_URL=https://lti-harness.127.0.0.1.nip.io:8444
export HARNESS_TOKEN=your-generated-test-token
mkdir -p _smoke_test/artifacts/moodle
```

Obtain a certificate for `lti-harness.127.0.0.1.nip.io` from your development CA.
Place its certificate at `_smoke_test/artifacts/moodle/tool.crt` and private key at
`_smoke_test/artifacts/moodle/tool.key`. These files are ignored by Git. Trust the
issuing CA in your browser and Moodle container; the command below mounts its public
certificate into the harness too. Do not mount the CA's private key.

```sh
docker build -t lti-test-harness:local .
docker run -d --name lti-harness-moodle --network "$MOODLE_DOCKER_NETWORK" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e PUBLIC_URL -e HARNESS_TOKEN -e NODE_EXTRA_CA_CERTS=/tls/ca.pem \
  -v "$MOODLE_DEV_CA:/tls/ca.pem:ro" \
  -v lti-harness-moodle-data:/data lti-test-harness:local

docker run -d --name lti-harness-moodle-tls --network "$MOODLE_DOCKER_NETWORK" \
  --network-alias lti-harness.127.0.0.1.nip.io -p 127.0.0.1:8444:8444 \
  -v "$PWD/_smoke_test/nginx-moodle.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/_smoke_test/artifacts/moodle:/tls:ro" nginx:alpine

curl --fail --cacert "$MOODLE_DEV_CA" "$PUBLIC_URL/health"
```

Use this route instead of starting a second Compose tool unnecessarily. If the
named containers already exist, inspect/reuse them rather than deleting their data.
The hostname resolves to loopback in the host browser and to the proxy through its
Docker network alias inside Moodle. Your DNS policy must allow that hostname.
A remote browser needs a genuinely reachable hostname and proxy, not this loopback example.

In Moodle, open **Site administration → Server → Security → HTTP security**
(or search site administration for **cURL allowed ports**). Add `8444`, preserving
existing ports, **one port per line**. Do not disable TLS verification or broadly
clear blocked-host settings. Confirm Moodle can retrieve the tool's public JWKS
URL before proceeding. See [network checks and environment details](docs/moodle.md).

Open `$PUBLIC_URL/admin` in your browser. Expect the tool endpoints and registration
forms, with no certificate error. Keep this page and Moodle open in separate tabs.

## 2. Register the tool in Moodle (LTI 1.3)

As a Moodle administrator:

1. Open **Site administration → Plugins → Activity modules → External tool → Manage tools**.
   On upstream Moodle, the direct path is `/mod/lti/toolconfigure.php`.
2. Click **configure a tool manually**. The harness does not implement automatic
   registration: do not use **Add LTI Advantage** with its URL.
3. Complete the fields below, replacing `TOOL_ORIGIN` with your `PUBLIC_URL`.

| Moodle field | Value |
| --- | --- |
| Tool name | `LTI test harness` |
| Tool URL | `TOOL_ORIGIN/lti/launch` |
| LTI version | `LTI 1.3` |
| Public key type | `Keyset URL` |
| Public keyset | `TOOL_ORIGIN/.well-known/jwks.json` |
| Initiate login URL | `TOOL_ORIGIN/lti/login` |
| Redirection URI(s) | `TOOL_ORIGIN/lti/launch` |
| Tool configuration usage | `Show as preconfigured tool when adding an external tool` |
| Default launch container | `Existing window` for the first test |
| Supports Deep Linking (Content-Item Message) | Checked |
| Content Selection URL | `TOOL_ORIGIN/lti/launch` |

For example, the complete Tool URL in the HTTPS example is
`https://lti-harness.127.0.0.1.nip.io:8444/lti/launch`.

4. Expand **Services**. Set **IMS LTI Assignment and Grade Services** to
   **Use this service for grade sync and column management**. Set **IMS LTI Names
   and Role Provisioning** to **Use this service to retrieve members' information
   as per privacy settings**. Tool Settings is not required.
5. Expand **Privacy**. Set **Accept grades from the tool** to **Always**. For these
   synthetic test accounts, set name/email sharing to **Always** if you want to
   inspect those values. Keep real personal data out of the test site.
6. Click **Save changes**. Find the new tool and open **View configuration details**.
   Leave its platform details visible for the next step.

Labels can vary between Moodle versions. The LTI project's separate `core_ltix`
development branch also requires an enabled activity placement and its Deep Linking
URL; see [branch-specific setup](docs/moodle.md). Upstream main does not use those
placement APIs. Copy the endpoints your actual site displays.

## 3. Register Moodle in the harness

In `$PUBLIC_URL/admin`, under **Register an LTI 1.3 platform**, enter:

| Harness field | Where the value comes from |
| --- | --- |
| Display name | Your own label, e.g. `Local Moodle main` |
| Issuer (exact platform value) | Moodle's **Platform ID** (copy exactly; commonly its configured site URL) |
| Client ID | The tool's **Client ID** from Moodle configuration details |
| Deployment IDs (comma separated) | The tool's **Deployment ID** from Moodle configuration details |
| Authentication URL | Moodle's **Authentication request URL** |
| Access token URL | Moodle's **Access token URL** |
| Public keyset URL | Moodle's **Public keyset URL** |
| Additional trusted service origins | Leave empty when services use the Moodle origin; add an explicit origin only if your deployment uses another one |

Click **Register platform**. The registered Moodle platform should appear on the
admin page. Registration is required in **both systems** before a launch can work.

For upstream main at `https://webserver`, the platform endpoints are normally
`https://webserver/mod/lti/auth.php`, `/mod/lti/token.php` and `/mod/lti/certs.php`.
The development branch may use `/ltix/` instead. Do not copy client/deployment IDs
from this README or another installation. Preserve exact URL spelling, scheme,
port and issuer trailing-slash behaviour; the harness validates them.

Registrations are immutable in this version. If you entered an incorrect value,
create a fresh Moodle tool/client and register its corrected details. Avoid resetting
an existing harness volume: that also deletes keys, registrations and captured tests.

## 4. Create and launch a test activity

Use a course with an enrolled teacher and a separate synthetic student. For an
initial setup you may use the administrator as the teacher, then repeat with the
actual teacher account. Keep student testing in a separate browser profile/context.

1. As teacher, open the course and turn editing on. Add an **External tool** activity
   and choose your preconfigured **LTI test harness**. Depending on the Moodle UI,
   select it from the activity chooser or the **Preconfigured tool** list.
2. For a plain launch, enter a name such as `Harness launch`, set its maximum grade
   to `100`, and save. If Moodle requires content selection for this configured
   tool, use the Deep Linking sequence in the next section instead.
3. Log in as the enrolled student and open the activity. Complete any explicit
   **Open in new window** prompt if you selected that launch container.
4. Expect the harness **Launch inspector**, `Protocol 1.3 · LtiResourceLinkRequest`,
   verified claims and the **What is 2 + 2?** question. Check the subject, course,
   resource link and learner role refer to the intended student/activity.
5. Enter `4` and click **Check answer**. Expect `correct: true` and `score: 100`.
   This saves a local answer only; it does **not** send a Moodle grade.

## 5. Test grading, roster and content selection

### Send a grade and verify it in Moodle

1. In the student's harness launch, enter score `83`, maximum `100`, score mode
   `value`, activity progress `Completed` and grading progress `FullyGraded`.
2. Keep **Line item URL** set to the activity's advertised URL and leave timestamp
   empty. Click **Send score for launched user**.
3. Expect an action result with `success: true` and a successful platform response.
   In Moodle, open that student's **Grades → User report**. Expect `83.00` for
   this activity. A successful HTTP response alone is not the gradebook check.
4. Return to the same harness session and click **Read results**. Expect a result
   for that student's user ID with score `83`.
5. Click **Read roster** and **Read line items**. Expect `success: true`, enrolled
   users including the learner, and the advertised grade collection.

**Create line item** deliberately adds another grade column and makes it the
session's default target. Test it after the activity-grade checks, or explicitly
restore the original **Line item URL** before sending another activity score.
The exact requested URL and payload appear in the action result/history.

### Add an activity through Deep Linking

1. As teacher, add another activity using the configured tool and click **Select content**.
2. In the harness selector, choose **One-question quiz**, enter a distinctive title,
   and click **Select content and prepare return**.
3. Click **Return to platform**. This second button submits the signed response to
   Moodle; preparing the response alone does not finish content selection.
4. Expect Moodle to show **Content selected** and populate the activity name. Save it.
5. As student, open the saved activity, answer the quiz and send a grade. Verify
   the new activity's grade in the student's Moodle user report.

Select **Claims explorer** instead when you want a resource that only displays
launch claims. Deep Linking advertises a grade line item and submission-review URL.

### Review the student's submission

After the student has answered the deep-linked quiz:

1. As teacher, use a submission-review link if your Moodle gradebook exposes one.
   The harness does not add a Moodle gradebook button.
2. On the tested upstream main, review was exercised by opening this actual Moodle
   URL while signed in as teacher:
   `MOODLE_ORIGIN/mod/lti/launch.php?id=CMID&action=gradeReport&user=STUDENT_ID`.
   Replace all placeholders. `CMID` is the activity's course-module ID from its
   `/mod/lti/view.php?id=...` link; `STUDENT_ID` is Moodle's user ID from the student's
   profile link, not a username or tool client ID. The user report's Actions menu
   may offer only **Grade analysis**, so absence of a review button is not a tool failure.
3. Expect `LtiSubmissionReviewRequest`, the intended learner and separate reviewer
   IDs, the learner's saved answer, and **This view is read-only**. There should be
   no answer/score controls. Review writes through the API must return 403.

## Optional: LTI 1.1 and automated checks

For LTI 1.1, first register a consumer in the harness `/admin` page with a chosen
key and shared secret. Include Moodle's origin in **Trusted outcome service origins**.
Create a separate Moodle tool using **LTI 1.0/1.1**, the same key/secret and
`PUBLIC_URL/lti/launch`; enable grade acceptance. Launch its activity as student,
use **Send outcome grade**, and verify the actual grade in Moodle. The LTI 1.3
platform registration does not replace this consumer registration.

After a real learner browser launch, copy its launch ID from `/session/<id>`:

```sh
export HARNESS_URL=https://your-tool.example.test
export HARNESS_TOKEN=your-test-token
export LAUNCH_ID=your-learner-launch-id
# For a private development CA, also export NODE_EXTRA_CA_CERTS=/path/to/public-ca.pem.
node _smoke_test/moodle-services.js
```

Expect exit 0: roster membership, score submission and the returned grade result
are asserted. This script intentionally sends grade `83` by default; use synthetic
learners. `TEST_SCORE` selects another grade, `CREATE_STANDALONE=true` adds/scores a
separate column, and `LEGACY_LAUNCH_ID` additionally checks a real 1.1 outcome.
See the [API contract](docs/api.md) for individual actions and captured transcripts.

For provisional scores, null/omitted clearing and stale timestamps, use the
[MDL-89973 reproduction guide](docs/MDL-89973.md). Its optional observer checks actual
Moodle grades and passing-grade completion, and the runner restores the final grade.
It exits 1 when the Moodle regressions are present; that is a detected LMS failure.
[Current-main validation](docs/moodle-main-validation.md) records those failures.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Tool works in your browser but Moodle cannot reach it | Common hostname/Docker network, outbound allowed ports (one per line), and Moodle's trust of the tool CA; test the JWKS URL from Moodle |
| Browser blocks an iframe | HTTPS tool URL for HTTPS Moodle; browser certificate trust; do not embed the local HTTP example |
| Unknown or ambiguous issuer/client | Register the exact Moodle issuer/client in the harness; check that the chosen Moodle activity uses that tool |
| Audience or deployment mismatch | Copy IDs from this tool's configuration details; clear unintended per-activity consumer credentials; the Moodle test generator's dummy `12345` key must not override a configured 1.3 client |
| Certificate verification failure in the tool or host script | Mount the public platform CA and set `NODE_EXTRA_CA_CERTS` for the actual Node process; do not disable verification |
| Deep-link return fails while fetching JWKS | Moodle must be able to download the tool's public keyset; check outbound port format and CA trust before changing signing keys |
| Token succeeds but AGS/NRPS returns 401 | Check whether Apache/PHP-FPM forwards Authorization; the tested environment correction is documented in [Moodle setup](docs/moodle.md#apache--php-fpm-authentication) |
| Service was not advertised / missing scope / 403 | Enable AGS/NRPS/grade acceptance, verify enrolment and resource association, then start a fresh launch to receive new claims |
| Grade updated the wrong column | Inspect the exact Line item URL; creating a line item changes the session default |
| Numeric resource-link ID rejected | Upstream main passed strict validation. Only for intentionally testing the nonconforming core_ltix baseline, set `ALLOW_NUMERIC_RESOURCE_LINK_ID=true`; captures retain a warning |
| Proxy 502 after a large OIDC hint or tool replacement | Use the supplied proxy's header buffers; after replacing the tool, run `docker exec lti-harness-moodle-tls nginx -s reload` to refresh its upstream DNS |

## Capabilities and validation scope

| Feature | Coverage |
| --- | --- |
| LTI 1.1 | HMAC-SHA1 launches and signed Basic Outcomes grade return |
| LTI 1.3 | OIDC, RS256 verification, issuer/client/deployment/target checks, one-use state/nonce |
| Deep Linking 2.0 | Single-resource signed response, preserved data and grade line item |
| AGS 2.0 / NRPS 2.0 | Read/create line items, send scores/read results, read memberships; pagination via API |
| Submission Review | Matching local learner answers, preserved for_user, read-only view |
| Manual / automation | Browser forms and bearer-authenticated JSON API; persisted claims and service transcripts |

Real upstream-main browser tests passed registration, Deep Linking, learner
interaction, grades, rosters and separate teacher review; see
[current-main results and exact commands](docs/moodle-main-validation.md).
The separate [development-baseline results](docs/moodle-validation.md) retain its
core_ltix failures. MDL-89973 remains reproducible on main. Fresh-install results do
not prove stored-URL migration, backup/restore, course copy or mobile interoperability.
The tool is not 1EdTech certified. LTI 2.0, dynamic registration, legacy Content-Item
selection, Tool Settings, full AGS CRUD and Asset Processor are not implemented.

## Configuration, persistence and development

| Setting | Default / use |
| --- | --- |
| `PUBLIC_URL` | `http://localhost:8080`; common public tool origin |
| `HARNESS_TOKEN` | Required, 16+ characters; admin password and API bearer token |
| `HARNESS_PORT` | `8080`; host loopback port in the standalone Compose file |
| `PORT` | `8080`; server listener inside the container |
| `DATA_DIR` | `/data` in Docker, `./data` on host |
| `NODE_EXTRA_CA_CERTS` | Optional path to public CA certificate for private platforms |
| `ALLOW_NUMERIC_RESOURCE_LINK_ID` | `false`; explicit development-branch compatibility |

Preserve `/data` across container replacements and Moodle upgrades. It contains
keys, registrations and captures; one process/replica may use each volume. The
latest 500 launches and 100 actions per launch are retained. Session URLs grant
access to captured test data and actions; protect them and use synthetic users.
Management routes require HTTP Basic `admin:HARNESS_TOKEN` or API bearer auth.
Outbound requests use registered origins, with redirects rejected.

For a Compose deployment, `docker compose stop` / `docker compose start` keeps its
data. Do not use `down -v` when you intend to preserve it. For the dedicated Docker
example, manage only its named tool/proxy containers and retain
`lti-harness-moodle-data`; do not tear down the shared Moodle stack.

Host-side development needs Node.js 22+ and no install step:

```sh
npm run check
npm test
HARNESS_TOKEN=local-development-token PUBLIC_URL=http://localhost:8080 npm start
```

The repository's CI workflow runs protocol tests against a synthetic platform and
builds/smoke-tests the image. Scheduled Moodle PHPUnit/Behat integration and a
published registry image remain separate project work; build the image locally.

More detail: [Moodle setup](docs/moodle.md) · [moodle-docker integration](integrations/moodle-docker/README.md) ·
[Testing](docs/testing.md) · [API](docs/api.md) · [Requirements and boundaries](docs/requirements.md).
