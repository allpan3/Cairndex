## Install

**Apple Silicon Macs only.** Download the `.dmg`, open it, and drag
**Cairndex** to Applications. There is no Intel build; on an Intel
Mac, build from source (see `docs/deployment.md`).

Cairndex is not signed with an Apple Developer ID, so the first
launch is blocked. Open it once, choose **Done**, then go to
**System Settings → Privacy & Security → Open Anyway**. The
README's install section has the full walkthrough — including that
**this step repeats on every update**, because each update is a
fresh quarantined download with a new ad-hoc signature.

Verify a download with the matching `.sha256` file:

```bash
shasum -a 256 -c Cairndex_<version>_<arch>.dmg.sha256
```

## Licensing

Cairndex is MIT licensed. Release artifacts bundle a GPL-licensed
FFmpeg; see the attached `THIRD-PARTY-NOTICES.md` for the written
source offer and the exact build that is included.
