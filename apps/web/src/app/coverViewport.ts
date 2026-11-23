// Share observations across the mounted cards of each scroll surface.
type Visibility = 'visible' | 'near' | 'outside'
type Card = { visible: boolean; near: boolean; notify: (value: Visibility) => void }

function observeSurface(root: Element | null) {
  const cards = new Map<Element, Card>()
  function observer(key: 'visible' | 'near', rootMargin: string) {
    return new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = cards.get(entry.target)
          if (!card) continue
          card[key] = entry.isIntersecting
          card.notify(card.visible ? 'visible' : card.near ? 'near' : 'outside')
        }
      },
      { root, rootMargin },
    )
  }
  return { cards, visible: observer('visible', '0px'), near: observer('near', '400px 0px') }
}

const surfaces = new Map<Element | null, ReturnType<typeof observeSurface>>()

export function observeCover(element: Element, notify: Card['notify']) {
  if (typeof IntersectionObserver === 'undefined') {
    notify('visible')
    return () => {}
  }
  const root = element.closest('.browser')
  const surface = surfaces.get(root) ?? observeSurface(root)
  surfaces.set(root, surface)
  surface.cards.set(element, { visible: false, near: false, notify })
  surface.visible.observe(element)
  surface.near.observe(element)
  return () => {
    surface.cards.delete(element)
    surface.visible.unobserve(element)
    surface.near.unobserve(element)
    if (!surface.cards.size) {
      surface.visible.disconnect()
      surface.near.disconnect()
      surfaces.delete(root)
    }
  }
}
