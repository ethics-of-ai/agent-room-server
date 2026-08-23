# Security

AgentRoom starts coding agents on the Mac it runs on, with the operator's own
credentials and, under the default postures, without a sandbox around the agent.
A flaw in how it bounds workspace access, authenticates clients, or handles the
profile and settings files can therefore reach the operator's machine. Please
report those privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: open the
**Security** tab and choose **Report a vulnerability**. That creates a private
advisory only the maintainers can see. Do not open a public issue or pull
request for a vulnerability.

Include what you can: the affected route, file, or setting, the configuration
you ran with (`AUTH_TOKEN` set or not, which runner, which permission or sandbox
posture), steps to reproduce, and the impact you observed.

You will get an acknowledgement in the advisory thread. Fixes land in the
private repository first and reach this mirror in the next sync; the advisory
is published once a release carrying the fix is out.

## Scope and posture

The documented trust posture, including known gaps, is
[Trust and safety](docs/safety/TRUST_AND_SAFETY.md). Read it before reporting
something it already lists as a deliberate default (for example that a
registered workspace is not a sandbox, or that the optional terminal is an
unsandboxed shell once enabled). Those are design decisions; a report that shows
one of them can be reached in a way the document says it cannot is exactly what
this process is for.

## Supported versions

The latest release on the Releases page. Older DMGs are not patched; update to
the newest release to receive fixes.
