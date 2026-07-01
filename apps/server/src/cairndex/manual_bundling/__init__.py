"""Manual bundling assistant (Unbundled staging follow-up to ADR-0009).

Scan stages every newly discovered file as a *provisional* one-file bundle; the
browse layer surfaces those as "unbundled" files in a dedicated view. This
package lets the owner turn unbundled files into confirmed bundles by hand,
reusing the grouping heuristics for suggestions and role assignment:

- :mod:`cairndex.manual_bundling.suggest` — read-only ranked suggestions
  (target bundles for selected files; unbundled files for a bundle or a seed
  selection). Suggestions are automatic on dialog open but never auto-applied.
- :mod:`cairndex.manual_bundling.apply` — the explicit, metadata-only mutations
  (add unbundled files to a confirmed bundle, create a confirmed bundle from
  unbundled files, create an empty confirmed bundle).

Everything here is metadata-only: files are re-parented and provisional source
bundles reaped, but nothing on disk is moved, copied, renamed, or deleted.
"""
