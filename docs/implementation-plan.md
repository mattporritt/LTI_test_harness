# Harness implementation plan

Standalone dependency-free Node.js service, Docker image, Compose configuration and CI.
Scope follows PRD v39 and workplan retrieved 28 October 2026: signed LTI 1.1 launches,
OIDC LTI 1.3 resource and submission-review launches, Deep Linking 2.0, AGS and NRPS.
Asset Processor is deferred by the workplan; LTI 2.0 registration, legacy Deep Linking
and Tool Settings are explicitly not implemented in this first harness. No certification claim.
Use published 1EdTech protocols, never Moodle-specific endpoint assumptions.

Acceptance: interactive content and inspectable claims; manual registration through UI/API;
persistent keys/registrations; one-time state/nonce and OAuth replay protection; exact stored
service URLs reusable across restart/upgrades; scoped service requests with transcripts;
automation API protected by token; reproducible success/failure tests with mock platform;
Docker build/runtime test and manual browser walk-through; exactly one self-review.

Branch: feat/standalone-lti-harness from fbd2d88. No Jira actions or Moodle changes.
Tests: node --test; Docker build and isolated runtime smoke; browser registration,
launch, deep linking selection and score/error states. Smoke scripts live in /_smoke_test.
