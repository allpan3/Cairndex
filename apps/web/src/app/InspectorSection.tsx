import type { ReactNode } from 'react'

import { IconChevronDown } from './icons'
import { useFoldedSections, type InspectorSectionId } from './inspectorSections'

/**
 * One foldable block of the Bundle Inspector — Notes, Tags, Collections,
 * Moments, Files (owner, 2026-08-30).
 *
 * The single-line facts above them (rating, count, size, date) stay put: they
 * are one line each and folding a one-line thing saves nothing.
 *
 * Which sections are folded is a *view* preference, so it lives in
 * localStorage and is shared by every bundle rather than stored per bundle: an
 * owner who does not use Notes wants them out of the way everywhere, not one
 * bundle at a time. It is also shared by the shell's rail and the viewer's
 * docked rail, which are the same component and should not disagree about
 * whether a section is open.
 */
export function InspectorSection({
  id,
  title,
  /** Rendered beside the title — an add affordance, a count. Never folded away,
   *  because a folded section still says how much is inside it. */
  actions,
  /** The section's own class, for the styling and the hit-testing its contents
   *  already depend on — the file rail finds a row under the pointer with
   *  `.files .file-row`, and that selector must keep matching. */
  className,
  children,
}: {
  id: InspectorSectionId
  title: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  const { folded, toggle } = useFoldedSections()
  const open = !folded[id]
  return (
    <section
      className={`ins-section${open ? '' : ' ins-section--folded'}${
        className ? ` ${className}` : ''
      }`}
      data-section={id}
    >
      {/* The whole header row folds, and the chevron only says so — it is on the
          right, and only while the pointer is on the row (owner, 2026-08-30). A
          rail of five headings should read as five labels at rest, not as five
          controls. */}
      <div className="ins-section__head">
        <button
          type="button"
          className="ins-section__toggle"
          aria-expanded={open}
          onClick={() => toggle(id)}
        >
          <span className="field-label">{title}</span>
        </button>
        {actions}
        <span
          className={`ins-section__chevron${open ? ' is-open' : ''}`}
          aria-hidden="true"
          // Part of the heading's own click target, not a control of its own:
          // pressing the glyph must fold like pressing anywhere else does.
          onClick={() => toggle(id)}
        >
          <IconChevronDown />
        </span>
      </div>
      {open && children}
    </section>
  )
}
