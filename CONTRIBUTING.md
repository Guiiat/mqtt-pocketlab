# Contributing to MQTT PocketLab

Thanks for improving the lab. Small, focused changes with a reproducible test are the easiest to review.

## Local setup

1. Install Node.js 22 or 24 and npm.
2. Fork and clone the repository.
3. Run `npm ci`.
4. Create a branch such as `feat/json-schema-assertions`.
5. Use `npm run dev` while iterating.
6. Run `npm run check` before opening a pull request.

## Design principles

- Keep the default experience local-only and safe.
- Prefer deterministic simulations. New device models must accept a seed.
- Bound memory, payloads, file paths, queues, and client-controlled input.
- Keep the browser console dependency-free unless a large benefit justifies a toolchain.
- Preserve existing NDJSON fields; add optional fields for backward compatibility.
- Do not claim protocol features the embedded broker does not support.

## Tests

- Unit-test generators, validation, and record transformations.
- Use ephemeral ports (`0`) for integration tests.
- Clean up MQTT clients, servers, timers, and temporary files in `afterEach`.
- A bug fix should include a test that failed before the fix.

## Pull requests

Explain the user problem, the chosen boundary, verification performed, and any security or compatibility impact. Update both READMEs when a user-facing workflow changes. Screenshots are welcome for console changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
