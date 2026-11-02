# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2   | No        |

Security fixes are released as a new 1.2.x version. Upgrade to the latest
1.2.x release; 1.1.0 and earlier receive no fixes.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Report it privately through GitHub: on the repository
[Niurmiguel/nestjs-service-bus](https://github.com/Niurmiguel/nestjs-service-bus),
open the **Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/Niurmiguel/nestjs-service-bus/security/advisories/new)).
Only the maintainers can see the report.

Include the version of this package, of NestJS and of `@azure/service-bus`,
what an attacker can do, and the steps or code to reproduce it.

This is a project maintained in spare time: expect a first answer within a
couple of weeks. If the report is confirmed, the fix is released and a GitHub
security advisory is published, crediting you unless you prefer otherwise. If
it is declined, you get the reason.

Note that the security of request-response also depends on how the Service Bus
entities and their access rights are set up: see "Security" in the
[README](https://github.com/Niurmiguel/nestjs-service-bus#security).
