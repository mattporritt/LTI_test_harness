# Requirements and scope

## Sources

Read on 28 October 2026 through the connected Atlassian tool:

- [PRD: LTI – Enable Seamless, System-Wide Integration in Moodle](https://moodle.atlassian.net/wiki/spaces/PSLMS/pages/3918790711), version 39.
- [LTI in core: 6.0 workplan](https://moodle.atlassian.net/wiki/spaces/PSLMS/pages/4555833355), especially section 4.1 and the basic/advanced harness milestones.

These ask for a standalone container tool: 1.1/1.3 launches with inspectable claims,
interactive content, deep linking, AGS, NRPS and submission review; Asset Processor
later. The advanced tool is a gate for the launch switch-over. T-HAR/T-PATH specifically
need stored `services.php` line item URLs to remain usable after Moodle upgrades.
This repository supplies the external tool; it does not modify Moodle or integrate
its PHPUnit/Behat configuration automatically.

## Expected behaviour

- Register multiple LTI 1.3 platforms and LTI 1.1 consumers from UI or JSON API.
- Verify launches before exposing received claims. Refuse invalid signatures,
  stale/replayed messages, unknown deployments, mismatched audiences and targets. Accept valid anonymous launches and empty role arrays.
- Work without third-party cookies or browser storage, including iframe launches.
- Select test content and return a signed Deep Linking 2.0 resource link with `data` preserved.
- Invoke advertised AGS/NRPS services using scoped platform credentials. Capture
  URL, method, scope, request body and response, excluding access tokens.
- Retain line item URLs verbatim; never rewrite `/mod/lti/` to `/ltix/`, and fail
  redirects rather than hiding compatibility regressions.
- Persist keys, registrations and captures across restarts so tests can exercise a
  URL captured before an LMS upgrade. Retain bounded histories.
- Offer local quiz content and read-only submission review of the selected learner.
- Package one non-root Docker image and reproducible tests usable without an LMS.

## Selection criteria and exclusions

Scope follows the workplan's explicit external-harness list, not every feature in
the broader Moodle migration. LTI 1.1 and 1.3 basic launches and the enumerated
advanced workflows are implemented. LTI 2.0 registration/launch is excluded from
this release: the workplan's wider regression matrix includes it, but its external
basic-tool milestone explicitly names 1.1 and 1.3. Existing characterisation tests
and vendor regression tools remain necessary for the 2.0 migration guardrail.

Manual and platform-initiated LTI dynamic registration of new clients are supported.
Registration updates are excluded. Deep Linking
supports one `ltiResourceLink`, not every accepted content type or bulk selection.
Basic Outcomes is supported, not legacy Content-Item selection. Tool Settings and
AGS line-item update/delete are future extensions. Asset Processor remains later
work as stated in the workplan. NRPS/AGS pagination is explicit through the API;
the UI shows the first page and the returned headers. No certification is claimed.

The harness supplies CI suitable for its own repository. Connecting the opt-in URL
and token to Moodle's PHPUnit/Behat suites, running across migration slices,
publishing an image to a chosen registry, partner tools and mobile-app validation
are integration/deployment work, not performed by this repository's test suite.

## Standards used

- [LTI Dynamic Registration 1.0](https://www.imsglobal.org/spec/lti-dr/v1p0)

- [LTI Core 1.3](https://www.imsglobal.org/spec/lti/v1p3/)
- [LTI security framework](https://www.imsglobal.org/spec/security/v1p0/)
- [Deep Linking 2.0](https://www.imsglobal.org/spec/lti-dl/v2p0)
- [Assignment and Grade Services 2.0](https://www.imsglobal.org/spec/lti-ags/v2p0)
- [Names and Role Provisioning 2.0](https://www.imsglobal.org/spec/lti-nrps/v2p0)
- [Submission Review 1.0 candidate final](https://www.imsglobal.org/spec/lti-sr/v1p0)
- [OAuth 1.0 / RFC 5849](https://www.rfc-editor.org/rfc/rfc5849)

Protocol implementation uses Node's built-in RSA/HMAC primitives and strict JWT
algorithm selection. The published RFC OAuth vector provides an independent
signature check in addition to the synthetic platform tests.
