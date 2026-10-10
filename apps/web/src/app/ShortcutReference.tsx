import { getHostPlatform } from '../platform'
import { formatAccelerator, shortcutReference } from '../platform/keymap'

// Separate focused-listing keys, shared video keys and desktop menu accelerators
export function ShortcutReference() {
  const desktop = getHostPlatform().kind === 'desktop'
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  const command = mac ? '⌘' : 'Ctrl+'
  const entries = shortcutReference()
  return (
    <section className="shortcut-reference" aria-label="Keyboard shortcuts" tabIndex={0}>
      <h3>Keyboard shortcuts</h3>
      <p>Click or Tab into the listing first. Text fields keep their editing keys.</p>
      <dl>
        <Shortcut label="Move selection" keys="Arrow keys" />
        <Shortcut label="Extend selection" keys="Shift + Arrow keys" />
        <Shortcut label="First / last loaded item" keys="Home / End" />
        <Shortcut label="Select loaded items" keys={`${command}A`} />
        <Shortcut label="Clear selection / close dialog" keys="Escape" />
      </dl>
      <h3>Video player</h3>
      <p>These keys apply while a video is open and focus is outside an editor.</p>
      <dl>
        {entries
          .filter((entry) => entry.keys.length)
          .map((entry) => (
            <Shortcut key={entry.label} label={entry.label} keys={entry.keys.join(' / ')} />
          ))}
      </dl>
      <h3>Desktop menus</h3>
      <p>
        {desktop
          ? 'Menu commands apply when the corresponding action is available.'
          : 'These shortcuts are available in the desktop app. In a browser, use the on-screen controls; browser shortcuts keep their normal behavior.'}
      </p>
      <dl>
        {entries
          .filter((entry) => entry.accelerator)
          .map((entry) => (
            <Shortcut
              key={`${entry.menu}:${entry.label}`}
              label={`${entry.menu} · ${entry.label}`}
              keys={formatAccelerator(entry.accelerator!, mac)}
            />
          ))}
      </dl>
    </section>
  )
}

// Keep shortcut labels readable without allowing long commands to widen the dialog
function Shortcut({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="shortcut-reference__row">
      <dt>{label}</dt>
      <dd>
        <kbd>{keys}</kbd>
      </dd>
    </div>
  )
}
