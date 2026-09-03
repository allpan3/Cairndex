import { IconPanelLeft, IconPanelRight } from './icons'

/**
 * The sidebar and inspector toggles.
 *
 * Both panels have always been hideable from the View menu, which is invisible
 * on the web and easy to forget in the shell; a button beside each panel is
 * where a hidden one is noticed and brought back (owner, 2026-09-01). Separate
 * components because they live in different places: the sidebar's rides in the
 * sidebar's own title strip while it is open (and moves into the toolbar when it
 * is not), the inspector's sits at the toolbar's far end.
 *
 * Neither carries a pressed highlight (owner, 2026-09-01). The panel beside the
 * button already says whether it is open, so an accent here only added a second,
 * louder answer to a question nobody was asking. `aria-pressed` still reports
 * the state to a screen reader, which has no panel to look at.
 */
export function SidebarToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      className="seg toolbar__panel-toggle"
      onClick={onToggle}
      aria-label="Toggle Sidebar"
      aria-pressed={visible}
      title="Toggle Sidebar"
    >
      <IconPanelLeft />
    </button>
  )
}

export function InspectorToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      className="seg toolbar__panel-toggle"
      onClick={onToggle}
      aria-label="Toggle Inspector"
      aria-pressed={visible}
      title="Toggle Inspector"
    >
      <IconPanelRight />
    </button>
  )
}
