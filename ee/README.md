# Fibteq Altair Enterprise

This directory holds features for larger organizations, such as SSO/SAML,
audit logs, advanced roles and data residency. None are here yet.

Code in `ee/` is licensed under the [Fibteq Altair Enterprise License](LICENSE),
not the AGPL. You can read it, run it for development and testing, and
contribute to it, but production use needs a commercial license from Fibteq.

Rules for contributors:

- Core code outside `ee/` must never import from `ee/`. Enterprise features
  plug into the core through extension points the core defines, so the AGPL
  build works without this directory.
- Every package or file added here carries this license. Do not move code from
  `ee/` to the core, or the other way, without a maintainer's approval.
