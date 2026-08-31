# Security policy

## Supported versions

Cairndex is pre-1.0. Before the replacement public release, security fixes land
on `main`; afterward, the newest published release and `main` are supported.
Older pre-1.0 releases may require upgrading rather than receiving a backport.

Direct public-internet exposure is not a supported deployment. Run Cairndex on
a trusted LAN or private overlay network and enable its owner passphrase or
paired-device token guard where appropriate.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/allpan3/Cairndex/security/advisories/new).
Please do not open a public issue for a vulnerability before a fix or safe
disclosure plan exists.

Include the affected version or commit, deployment surface (browser, desktop, or
Docker), reproduction steps, impact, and any mitigation you already tested. Do
not attach real library media, screenshots, filenames, paths, titles, tags,
notes, URLs, or other owner data. Reduce the report to synthetic data; if a
private artifact is essential, say so first and arrange a safe transfer rather
than uploading it to GitHub.

Reports about committed or published private owner data are security reports,
even when the data is only a string or an extensionless file. Include the
reachable commit, pull request, release, or package reference without repeating
the private content itself.

## What to expect

The maintainer will acknowledge a report, reproduce it where possible, and
coordinate a fix and disclosure. Timing depends on impact and reproducibility;
no fixed service-level agreement is promised for this personal project.
