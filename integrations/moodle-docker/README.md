# moodle-docker integration

The supplied `lti-harness.yml` is an **optional Compose fragment**. It follows the
existing external-test-service pattern: a service on the project's default network,
configuration exposed to `webserver`, and a project-scoped persistent volume. It
works through the local moodle-docker wrapper without changing that repository.
There are no fixed container names, host ports or machine-specific paths.

## Start through the wrapper

Build the image in this repository first:

```sh
docker build -t lti-test-harness:local .
export LTI_HARNESS_REPO=/absolute/path/to/LTI_test_harness
export MOODLE_DOCKER_LTI_HARNESS_TOKEN=choose-a-random-token-of-at-least-16-characters
cd /absolute/path/to/moodle-docker

bin/moodle-docker-compose -f "$LTI_HARNESS_REPO/integrations/moodle-docker/lti-harness.yml" config --quiet
bin/moodle-docker-compose -f "$LTI_HARNESS_REPO/integrations/moodle-docker/lti-harness.yml" up -d --no-deps ltimock
```

The `-f` option is appended to the wrapper's normal fragments. Alternatively, merge
this fragment into your existing ignored `moodle-docker/local.yml`; preserve any
existing local settings. Do not overwrite that file. The wrapper does **not** yet
autoload an LTI fragment from an environment flag, unlike its built-in BBB/Matrix
switches: include the fragment explicitly on commands that manage this service.

`--no-deps ltimock` starts only the tool. It does not recreate Moodle, its database
or Selenium. To inject the webserver environment entries, include the fragment in
your normal test-stack creation command. An already running webserver does not gain
environment variables from `config` or from starting only `ltimock`. For a temporary
probe, pass the URL/token explicitly with `docker exec -e` instead.

Set `MOODLE_DOCKER_INSTANCE` normally for additional instances. The wrapper selects
the correct project/network; each project gets its own `lti-harness-data` volume.
Use separate projects/instances for parallel PHPUnit or Behat jobs. Do not share
one volume between replicas. No BBB-style hash URL prefix is required or supported.

| Variable | Meaning |
| --- | --- |
| `MOODLE_DOCKER_LTI_HARNESS_IMAGE` | Existing built/pulled image; default `lti-test-harness:local` |
| `MOODLE_DOCKER_LTI_HARNESS_TOKEN` | Required per-instance API/admin test secret |
| `MOODLE_DOCKER_LTI_HARNESS_PUBLIC_URL` | Registered tool origin; default `http://ltimock:8080` |
| `MOODLE_DOCKER_LTI_HARNESS_API_URL` | Webserver's management API origin; default `http://ltimock:8080` |
| `ALLOW_NUMERIC_RESOURCE_LINK_ID` | Optional explicit development-branch compatibility; default false |

The fragment injects `MOODLE_DOCKER_LTI_HARNESS=true`, `TEST_LTI_TOOL_URL` and
`TEST_LTI_TOOL_TOKEN` into a newly created webserver. These are this harness's
integration contract, **not pre-existing Moodle core test constants**. Tests must
read the environment or define corresponding constants in their test configuration.
The fragment does not install Moodle tests, alter the site's config.php, or make
ordinary Moodle test suites automatically start using the tool.

## PHP / PHPUnit and Behat use

Use opt-in tests: skip external-tool assertions when `TEST_LTI_TOOL_URL` or its token
is absent. Authenticate `/api/*` with `Authorization: Bearer <TEST_LTI_TOOL_TOKEN>`.
Read `/api/launches`, correlate the intended learner/context/custom marker, then
POST an action and assert both `success` and the observed LMS state. HTTP acceptance
alone misses issues such as [MDL-89973](../../docs/MDL-89973.md).

The Docker hostname `ltimock` resolves from webserver and Selenium, so automated
browsers can launch it on the same network. In the isolated test site's HTTP
security configuration, permit outbound port **8080** (preserve existing entries).
For a one-process PHP probe, set `$CFG->curlsecurityallowedport` after loading config
instead of persisting a database setting. The initial registration needs the real
PHPUnit/Behat site issuer, client ID, deployment and platform endpoints, which may
differ from the development site. Do not assume the test site's URL is `https://webserver`.

Run Moodle's own initialization and test tools as usual, with the same selected
instance. This integration adds a service; it does not replace `behat-init`,
`behat-run`, `phpunit` or their existing external-service setup.

## HTTPS and manual browsers

The default internal HTTP URL is for HTTP test sites and containers. It is not a
host-browser hostname and cannot be embedded in an HTTPS site without mixed-content
blocking. For an HTTPS test site, provide a trusted HTTPS proxy on the same network,
point `MOODLE_DOCKER_LTI_HARNESS_PUBLIC_URL` at that common browser/LMS origin,
and proxy to `ltimock:8080`. Keep `TEST_LTI_TOOL_URL` as the internal API origin if
convenient. Mount the platform's public development CA into the tool and set
`NODE_EXTRA_CA_CERTS` using a local Compose extension. Do not disable TLS checks.

See the [verified HTTPS setup](../../docs/moodle.md) and proxy sample under
`_smoke_test/`; adjust its upstream name from `lti-harness-moodle` to `ltimock` when
using the Compose-managed service. Keep the proxy's large OIDC response-header
buffer. The development HTTPS tool and optional internal service can run together;
they have separate volumes and registrations. Neither shares Moodle's database.

## Lifecycle and evidence

Use the same wrapper/fragment when checking `ps`, `logs ltimock`, or stopping just
this service. Do not use `down -v` on a shared Moodle project. If Compose reports
other optional test services as orphans because their fragments were not selected,
leave them alone; do not pass `--remove-orphans`.

Local validation started `moodlemaster-ltimock-1` with the actual wrapper and
confirmed `/health` from Moodle's `curl` class and the existing Selenium container.
The real issue sequence used the separate trusted HTTPS tool, with grade/completion
observations from the actual Moodle database. No shared Moodle container was
recreated to perform the service-fragment validation.
