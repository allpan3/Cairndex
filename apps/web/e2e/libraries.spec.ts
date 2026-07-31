import { expect, test, type Page } from '@playwright/test'

// Hermetic mock of the unified add-library flow (ADR-0008). With no libraries
// the app shows an empty shell; clicking "+" opens the manager, and adding one
// transitions into the workspace. No backend required.

const registered = (id: string, name: string, root: string) => ({
  id,
  library_uuid: id,
  name,
  root_path: root,
  status: 'available',
  schema_version: 1,
  created_at: 'x',
  updated_at: 'x',
  last_opened_at: null,
})

async function mockApi(
  page: Page,
  options: {
    probeIsLibrary?: boolean
    manySuggestions?: boolean
    /** Seeds the list, which is what pushes the add row down the dialog. */
    startingLibraries?: Array<Record<string, unknown>>
  } = {},
) {
  const libraries: Array<Record<string, unknown>> = [...(options.startingLibraries ?? [])]
  // A root listing is long enough to fill the menu to its maximum height, which
  // is when it stops fitting inside the dialog — the real reported case.
  const long = 'abcdefghijkl'
    .split('')
    .map((letter) => ({ path: `/mnt/${letter.repeat(3)}`, is_library: letter === 'c' }))

  await page.route('**/bundles/counts**', (r) =>
    r.fulfill({ json: { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 } }),
  )
  await page.route('**/collections?*', (r) => r.fulfill({ json: { items: [], next_cursor: null } }))
  await page.route('**/collections/counts**', (r) => r.fulfill({ json: { counts: {} } }))
  await page.route('**/smart-collections', (r) => r.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (r) =>
    r.fulfill({ json: { items: [], total: 0, offset: 0, limit: 100 } }),
  )
  await page.route('**/auth/status', (r) =>
    r.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/ownership', (r) => r.fulfill({ json: { state: 'own', mountable: true } }))

  // Directory autocomplete, with one entry already marked as a library.
  await page.route('**/path-suggestions**', (r) =>
    r.fulfill({
      json: {
        suggestions: options.manySuggestions
          ? long
          : [
              { path: '/mnt/media', is_library: false },
              { path: '/mnt/music', is_library: true },
              { path: '/mnt/movies', is_library: false },
            ],
      },
    }),
  )

  // What the typed path is. The modal asks once, on submit.
  await page.route('**/probe-path**', (r) =>
    r.fulfill({
      json: {
        exists: true,
        is_library: options.probeIsLibrary ?? false,
        already_registered_id: null,
        manifest_display_name: options.probeIsLibrary ? 'Existing Library' : null,
        folder_name: 'media',
      },
    }),
  )

  const created = (body: Record<string, unknown>, name: unknown) => {
    const lib = {
      id: 'lib1',
      library_uuid: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      name,
      root_path: body.root_path,
      status: 'available',
      schema_version: 1,
      created_at: 'x',
      updated_at: 'x',
      last_opened_at: null,
    }
    libraries.push(lib)
    return lib
  }

  await page.route('**/api/v1/libraries/create', async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>
    await r.fulfill({ status: 201, json: created(body, body.display_name) })
  })
  await page.route('**/api/v1/libraries/register', async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>
    await r.fulfill({ status: 201, json: created(body, 'Existing Library') })
  })

  // Deregistration is metadata-only; the mock just drops the row.
  await page.route('**/api/v1/libraries/lib1', async (r) => {
    if (r.request().method() !== 'DELETE') return r.fallback()
    libraries.length = 0
    await r.fulfill({ status: 204, body: '' })
  })

  // Libraries list (mutable).
  await page.route('**/api/v1/libraries', (r) => r.fulfill({ json: libraries }))
}

test('adds a plain folder as a new library through one confirmation', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  // No libraries yet → empty shell. Open the manager from the sidebar "+".
  await expect(page.locator('.center')).toContainText('No library yet')
  await page.getByRole('button', { name: 'Manage libraries' }).click()

  // One path field, no create/register choice. Autocomplete marks the folder
  // that already is a library.
  await page.getByLabel('Library path').fill('/mnt')
  await expect(page.getByRole('option', { name: '/mnt/music' })).toContainText('library')
  await page.getByRole('option', { name: '/mnt/media' }).click()
  await expect(page.getByLabel('Library path')).toHaveValue('/mnt/media/')

  await page.getByRole('button', { name: 'Add library' }).click()

  // Not a library → confirm a name, prefilled with the folder's own.
  const name = page.getByLabel('Library name')
  await expect(name).toHaveValue('media')
  await name.fill('NAS Media')
  await page.getByRole('button', { name: 'Create library' }).click()

  // The app transitions into the workspace with the new library selected.
  await expect(page.locator('.sidebar__library-select')).toHaveValue('lib1')
  await expect(page.locator('.sidebar__library-select')).toContainText('NAS Media')
})

test('walks the suggestion menu with the keyboard alone', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries' }).click()

  const path = page.getByLabel('Library path')
  await path.fill('/mnt')
  await expect(page.getByRole('option', { name: '/mnt/media' })).toBeVisible()

  await path.press('ArrowDown')
  await path.press('ArrowDown')
  await path.press('Enter')

  // Taking a suggestion drills in rather than ending the interaction.
  await expect(path).toHaveValue('/mnt/music/')
  await expect(page.getByRole('listbox')).toBeVisible()
})

// The whole menu must be *reachable*, in a real layout. The dialog scrolls its
// own content, so an absolutely positioned menu is clipped at the dialog's edge
// unless it opts out — and the add row is the last thing in the dialog, so
// "below the field" is routinely the direction with no room. Neither fact is
// visible to a jsdom test, which is why this lives here.
//
// The assertion is a hit test, not a bounding box: a clipped element still
// reports its layout box, which is exactly how a first version of this test
// passed against the clipping it was written to catch.
test.describe('the suggestion menu stays on screen', () => {
  for (const [label, height] of [
    ['with room below the field', 900],
    // The reported case: registered libraries push the add row down a short
    // window, so a full listing below the field would run off the screen.
    ['with the field near the bottom', 620],
  ] as const) {
    test(label, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height })
      await mockApi(page, {
        manySuggestions: true,
        startingLibraries: [
          registered('01H', 'lex', '/Volumes/media/library'),
          registered('01J', 'Demo', '/Users/owner/DemoLibrary'),
        ],
      })
      await page.goto('/')
      await page.getByRole('button', { name: 'Manage libraries' }).click()
      await page.getByLabel('Library path').click()
      await expect(page.getByRole('option', { name: '/mnt/aaa' })).toBeVisible()

      // The menu is on screen at both edges. It scrolls its own overflow, so
      // this is about the menu, not about every option being drawn at once.
      const menu = (await page.locator('.path-input__menu').boundingBox())!
      expect(menu.y, 'the menu starts above the window').toBeGreaterThanOrEqual(0)
      expect(menu.y + menu.height, 'the menu runs past the window').toBeLessThanOrEqual(height)

      // Both edges of the menu are actually painted where they claim to be: a
      // dialog that clips leaves its own surface there while the layout box
      // still reports the full menu.
      for (const [edge, y] of [
        ['top', menu.y + 4],
        ['bottom', menu.y + menu.height - 4],
      ] as const) {
        const painted = await page.evaluate(
          ([x, at]) =>
            !!document.elementFromPoint(x as number, at as number)?.closest('.path-input__menu'),
          [menu.x + menu.width / 2, y],
        )
        expect(painted, `the menu's ${edge} edge is clipped away`).toBe(true)
      }

      // And the far end of the list — reached by scrolling the menu itself —
      // still takes the click.
      await page.getByRole('option', { name: '/mnt/lll' }).click()
      await expect(page.getByLabel('Library path')).toHaveValue('/mnt/lll/')
    })
  }
})

test('confirming a new library needs no pointer movement', async ({ page }) => {
  // Owner-reported: the confirmation used to appear above the form and shift
  // the button away, so the second click meant finding it again. Measured here
  // rather than described, because "the button moved" is a fact about layout.
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries' }).click()
  await page.getByLabel('Library path').fill('/mnt/media')

  const add = page.getByRole('button', { name: 'Add library' })
  const before = (await add.boundingBox())!
  const pointer = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
  await add.click()

  const confirm = page.getByRole('button', { name: 'Create library' })
  await expect(confirm).toBeVisible()
  const after = (await confirm.boundingBox())!

  // The row itself does not move: same top, same height. The label changes
  // width, so only the button's left edge shifts — its right edge is anchored.
  expect(after.y, 'the add row moved vertically').toBe(before.y)
  expect(after.height, 'the button changed height').toBe(before.height)

  // And the pointer never left the button: where it was resting is still in it.
  expect(
    pointer.x,
    'the button moved horizontally out from under the pointer',
  ).toBeGreaterThanOrEqual(after.x)
  expect(pointer.x).toBeLessThanOrEqual(after.x + after.width)
  expect(
    pointer.y,
    'the button moved vertically out from under the pointer',
  ).toBeGreaterThanOrEqual(after.y)
  expect(pointer.y).toBeLessThanOrEqual(after.y + after.height)

  // So a second click at the resting position confirms.
  await page.mouse.click(pointer.x, pointer.y)
  await expect(page.locator('.sidebar__library-select')).toContainText('media')
})

test('a click elsewhere in the dialog dismisses the menu but keeps the dialog', async ({
  page,
}) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries' }).click()
  await page.getByLabel('Library path').fill('/mnt')
  await expect(page.getByRole('option', { name: '/mnt/media' })).toBeVisible()

  await page.getByRole('heading', { name: 'Libraries' }).click()

  await expect(page.getByRole('listbox')).toBeHidden()
  // The click that dismissed the menu must not also dismiss the dialog: the
  // dialog swallows it for exactly that reason, which is what made this
  // dismissal need the capture phase in the first place.
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByLabel('Library path')).toHaveValue('/mnt')
})

test('adds an existing library folder without asking for a name', async ({ page }) => {
  await mockApi(page, { probeIsLibrary: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries' }).click()

  await page.getByLabel('Library path').fill('/mnt/music')
  await page.getByRole('button', { name: 'Add library' }).click()

  // It keeps the name it travels with; no confirmation step appears.
  await expect(page.locator('.sidebar__library-select')).toContainText('Existing Library')
})

test('removes a library after confirming, and says files are untouched', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Manage libraries' }).click()
  await page.getByLabel('Library path').fill('/mnt/media')
  await page.getByRole('button', { name: 'Add library' }).click()
  await page.getByRole('button', { name: 'Create library' }).click()
  await expect(page.locator('.sidebar__library-select')).toHaveValue('lib1')

  await page.getByRole('button', { name: 'Manage libraries' }).click()
  await page.getByRole('button', { name: 'Remove media' }).click()
  await expect(page.locator('.lib-row--confirm')).toContainText('files are not touched')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()

  // Back to the empty shell, which is the no-library state the app already has.
  await expect(page.locator('.center')).toContainText('No library yet')
})

test('switching libraries replaces the browser shell without a reload', async ({ page }) => {
  const libraries = [
    { id: 'lib1', name: 'Library One', root_path: '/srv/one', status: 'available' },
    { id: 'lib2', name: 'Library Two', root_path: '/srv/two', status: 'available' },
  ]
  const item = (libraryId: string) => ({
    id: `${libraryId}-bundle`,
    title: libraryId === 'lib1' ? 'First Library Movie' : 'Second Library Movie',
    rating: null,
    file_count: 1,
    total_size: 100,
    has_missing: false,
    has_cover: false,
    media_kind: 'video',
    width: 1920,
    height: 1080,
    duration: 60,
    extension: 'mp4',
    date_added: '2026-07-10T00:00:00Z',
  })
  const libraryFrom = (url: string) => (url.includes('/lib2/') ? 'lib2' : 'lib1')

  await page.route('**/api/v1/libraries', (route) => route.fulfill({ json: libraries }))
  await page.route('**/auth/status', (route) =>
    route.fulfill({ json: { protected: false, unlocked: true } }),
  )
  await page.route('**/ownership', (route) =>
    route.fulfill({ json: { state: 'own', mountable: true } }),
  )
  await page.route('**/bundles/counts**', (route) =>
    route.fulfill({ json: { all: 1, recent: 1, uncategorized: 1, untagged: 1, missing: 0 } }),
  )
  await page.route('**/collections/counts**', (route) => route.fulfill({ json: { counts: {} } }))
  await page.route('**/collections?*', (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  )
  await page.route('**/smart-collections', (route) => route.fulfill({ json: [] }))
  await page.route('**/bundles/browse**', (route) => {
    const libraryId = libraryFrom(route.request().url())
    route.fulfill({ json: { items: [item(libraryId)], total: 1, offset: 0, limit: 100 } })
  })

  await page.addInitScript(() => localStorage.removeItem('cairndex.libraryId'))
  await page.goto('/')
  await expect(page.getByText('First Library Movie')).toBeVisible()

  await page.getByRole('combobox', { name: 'Library' }).selectOption('lib2')
  await expect(page.getByRole('combobox', { name: 'Library' })).toHaveValue('lib2')
  await expect(page.getByText('Second Library Movie')).toBeVisible()
  await expect(page.getByText('First Library Movie')).toHaveCount(0)
})
