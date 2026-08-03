# Security policy

## Supported versions

Until the first stable release, security fixes are made on the latest `0.x` release and the default branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** private advisory flow in the repository Security tab. Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. Maintainers should acknowledge a report within seven days.

## Deployment boundary

MQTT PocketLab is a development laboratory, not a hardened production broker.

- Keep the default `127.0.0.1` listener whenever possible.
- Remote binding requires `--allow-remote`, `--username`, and `--password` (or the corresponding environment variables).
- Remote mode does not provide TLS. Plain HTTP Basic and MQTT credentials can be observed on an untrusted network. Use a trusted isolated network, or keep the loopback listener and reach it through an SSH port-forward. The `0.1.x` same-origin guard does not support an HTTPS-terminating reverse-proxy origin.
- Do not reuse production passwords or expose production secrets in recordings.
- Review NDJSON before sharing it: payloads may contain application data even though file paths and sizes are bounded.

The implementation caps client publishes at 1 MiB, each recording session at 100 MiB by default, console previews at 8 KiB, topics in memory at 500, recent messages at 100, SSE clients at 32, topic depth at 16, keepalive at 300 seconds, and TCP connections at 1,000. Recording backpressure drops are reported rather than buffered without bound. These are defense-in-depth limits, not a guarantee against all denial-of-service conditions.
