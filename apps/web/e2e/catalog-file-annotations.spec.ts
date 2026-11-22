import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiPost, openMetadataReview, proxyApi, startBackend, stopBackend } from './realBackend'

test.use({ actionTimeout: 15_000 })

const PYTHON_FIXTURE = `
import json
from pathlib import Path
import shutil
import sys
from PIL import Image
from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.persistence.sqlite_durability import connect_writable
from cairndex.replicas.catalog.conversion import prepare_disposable

parent = Path(sys.argv[1])
fixture = create_disposable(parent=parent, bundles=3)

dirs = {
    "Loose/alpha.png": "#3b6e8c",
    "Loose/beta.png": "#8c563b",
    "Gallery/nested.png": "#4c7a49",
    "Single/solo.png": "#74528c",
    "Plain/blank.png": "#696969",
}
sizes = {}
for rel, color in dirs.items():
    target = fixture.source / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 180), color).save(target)
    sizes[rel] = target.stat().st_size

with connect_writable(fixture.source / ".cairndex/library.db") as db:
    for tbl in (
        "asset_file_stars",
        "asset_file_tags",
        "asset_bundle_tags",
        "moment_tags",
        "moments",
        "subtitle_tracks",
        "playback_progress",
        "bundle_cursors",
        "bundle_directory_members",
        "asset_bundle_collections",
        "tag_group_memberships",
        "tag_groups",
        "collections",
        "smart_folders",
    ):
        db.execute(f"DELETE FROM {tbl}")
    db.execute("UPDATE asset_bundles SET cover_file_id=NULL, primary_file_id=NULL")
    db.execute("DELETE FROM asset_files")
    db.execute("DELETE FROM asset_bundles")
    db.execute("DELETE FROM tags")

    for bundle_id, title, order, cover_id in (
        ("bundle-multi", "Synthetic Multi Bundle", 1, "file-alpha"),
        ("bundle-single", "Synthetic Single Bundle", 2, "file-solo"),
        ("bundle-plain", "Synthetic Plain Bundle", 3, "file-plain"),
    ):
        insert_row(
            db,
            "asset_bundles",
            synthetic_row(
                "asset_bundles",
                bundle_id,
                title=title,
                notes=None,
                rating=None,
                extra_metadata="{}",
                grouping_state="CONFIRMED",
                grouping_source="MANUAL",
                manual_order=order,
                cover_file_id=cover_id,
                primary_file_id=cover_id,
            ),
        )

    files = (
        ("file-alpha", "bundle-multi", "Loose/alpha.png", "Loose", "alpha.png", 1),
        ("file-beta", "bundle-multi", "Loose/beta.png", "Loose", "beta.png", 2),
        ("file-nested", "bundle-multi", "Gallery/nested.png", "Gallery", "nested.png", 3),
        ("file-solo", "bundle-single", "Single/solo.png", "Single", "solo.png", 1),
        ("file-plain", "bundle-plain", "Plain/blank.png", "Plain", "blank.png", 1),
    )
    for file_id, bundle_id, rel, folder, name, seq in files:
        insert_row(
            db,
            "asset_files",
            synthetic_row(
                "asset_files",
                file_id,
                bundle_id=bundle_id,
                relative_path=rel,
                directory_path=folder,
                original_filename=name,
                display_title=name,
                media_kind="IMAGE",
                role="IMAGE",
                mime_type="image/png",
                sequence=seq,
                note=None,
                source=None,
                size_bytes=sizes[rel],
                tech_metadata='{"width":320,"height":180}',
            ),
        )

    insert_row(
        db,
        "bundle_directory_members",
        synthetic_row(
            "bundle_directory_members",
            "dir-gallery",
            bundle_id="bundle-multi",
            directory_path="Gallery",
            sequence=3,
        ),
    )

    for tag_id, name, parent_id, sort_order in (
        ("tags-scene", "Scene", None, 1),
        ("tags-blue", "Blue", "tags-scene", 1),
        ("tags-amber", "Amber", None, 2),
        ("tags-warm", "Warm", None, 3),
    ):
        insert_row(
            db,
            "tags",
            synthetic_row(
                "tags",
                tag_id,
                name=name,
                parent_id=parent_id,
                sort_order=sort_order,
            ),
        )

    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Invalid synthetic relationships")

package = prepare_disposable(fixture, format_version=3).package
for folder in ("Loose", "Gallery", "Single", "Plain"):
    shutil.copytree(fixture.source / folder, package / folder)
print(package)
`

function buildFixture(scratch: string): string {
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  return execFileSync('uv', ['run', 'python', '-c', PYTHON_FIXTURE, scratch], {
    cwd: serverDir,
    encoding: 'utf8',
  }).trim()
}

async function runPreviewAndCommit(baseUrl: string, libraryId: string, command: unknown) {
  const base = `/api/v1/libraries/${libraryId}/replica/catalog`
  const previewOp = randomUUID().replaceAll('-', '')
  await apiPost(baseUrl, `${base}/jobs`, {
    action: 'preview',
    body: command,
    operation: previewOp,
  })
  let previewJob: { id: string; state: string; receipt: string; error?: string } | null = null
  await expect
    .poll(
      async () => {
        const res = await fetch(`${baseUrl}${base}/jobs/${previewOp}`)
        previewJob = (await res.json()) as typeof previewJob
        return previewJob?.state
      },
      { timeout: 30_000 },
    )
    .toBe('succeeded')
  if (!previewJob) throw new Error('preview job missing')
  const commitOp = randomUUID().replaceAll('-', '')
  await apiPost(baseUrl, `${base}/jobs`, {
    action: 'commit_preview',
    body: { job: previewJob.id, receipt: previewJob.receipt },
    operation: commitOp,
  })
  await expect
    .poll(
      async () => {
        const res = await fetch(`${baseUrl}${base}/jobs/${commitOp}`)
        return ((await res.json()) as { state: string }).state
      },
      { timeout: 30_000 },
    )
    .toBe('succeeded')
}

async function exchangeReplicas(rootA: string, rootB: string) {
  for (let i = 0; i < 3; i += 1) {
    await cp(join(rootA, '.cairndex/replica/objects'), join(rootB, '.cairndex/replica/objects'), {
      recursive: true,
    })
    await cp(join(rootB, '.cairndex/replica/objects'), join(rootA, '.cairndex/replica/objects'), {
      recursive: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

test('open bundle triggers, per-file stars/tags/notes, album filters, smart collections and mobile layout @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-file-annotations-')))
  const root = buildFixture(scratch)
  const backend = await startBackend(join(scratch, 'private'))
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  try {
    await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
      root_path: root,
    })
    const page = await context.newPage()
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')

    const bundlesList = page.getByRole('listbox', { name: 'Bundles', exact: true })
    const multiCard = bundlesList.locator('[data-bundle-id="bundle-multi"]')
    const singleCard = bundlesList.locator('[data-bundle-id="bundle-single"]')
    await expect(multiCard).toBeVisible({ timeout: 30_000 })
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    // 1. Open Bundle entry points & exit paths
    await multiCard.getByRole('button', { name: 'Open bundle (3 files)', exact: true }).click()
    const listing = page.getByRole('list', { name: 'Album items', exact: true })
    await expect(listing).toBeVisible()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await expect(listing).toHaveCount(0)

    // Single-file hover trigger + Escape clearing selection then exiting Album
    await singleCard.hover()
    await singleCard.getByRole('button', { name: 'Open bundle', exact: true }).click()
    await expect(listing.locator('[data-file-id="file-solo"]')).toBeVisible()
    await listing.locator('[data-file-id="file-solo"]').click()
    const fileInspector = page.getByRole('complementary', { name: 'File inspector', exact: true })
    await expect(fileInspector).toBeVisible()
    await listing.press('Escape')
    await expect(fileInspector).toHaveCount(0)
    await expect(listing).toBeVisible()
    await listing.press('Escape')
    await expect(listing).toHaveCount(0)

    // List layout trigger
    await page.getByRole('button', { name: 'List', exact: true }).click()
    await bundlesList
      .locator('[data-bundle-id="bundle-multi"]')
      .getByRole('button', { name: 'Open bundle (3 files)', exact: true })
      .click()
    await expect(listing).toBeVisible()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Card', exact: true }).click()

    // Keyboard shortcut (Cmd+ArrowDown on Mac, Alt+ArrowDown elsewhere)
    await multiCard.click()
    const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    await bundlesList.press(isMac ? 'Meta+ArrowDown' : 'Alt+ArrowDown')
    await expect(listing).toBeVisible()

    // 2. Per-file Stars in Album: tile star button, context menu single & bulk, File Inspector, sub-folder
    const alphaTile = listing.locator('[data-file-id="file-alpha"]')
    const betaTile = listing.locator('[data-file-id="file-beta"]')
    const galleryDir = listing.locator('[data-file-id="dir-gallery"]')
    await expect(alphaTile).toBeVisible()
    await expect(betaTile).toBeVisible()
    await expect(galleryDir).toBeVisible()

    await alphaTile.getByRole('button', { name: 'Star alpha.png', exact: true }).click()
    await expect(
      alphaTile.getByRole('button', { name: 'Unstar alpha.png', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')

    // Context menu unstar single
    await alphaTile.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unstar', exact: true }).click()
    await expect(
      alphaTile.getByRole('button', { name: 'Star alpha.png', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false')

    // Multi-select star & unstar via context menu
    await alphaTile.click()
    await betaTile.click({ modifiers: ['ControlOrMeta'] })
    await betaTile.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Star 2 Files', exact: true }).click()
    await expect(
      alphaTile.getByRole('button', { name: 'Unstar alpha.png', exact: true }),
    ).toBeVisible()
    await expect(
      betaTile.getByRole('button', { name: 'Unstar beta.png', exact: true }),
    ).toBeVisible()
    await betaTile.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unstar 2 Files', exact: true }).click()
    await expect(
      alphaTile.getByRole('button', { name: 'Star alpha.png', exact: true }),
    ).toBeVisible()
    await expect(betaTile.getByRole('button', { name: 'Star beta.png', exact: true })).toBeVisible()

    // Star inside collapsed Gallery folder
    await galleryDir.dblclick()
    const nestedTile = listing.locator('[data-file-id="file-nested"]')
    await expect(nestedTile).toBeVisible({ timeout: 30_000 })
    await nestedTile.getByRole('button', { name: 'Star nested.png', exact: true }).click()
    await expect(
      nestedTile.getByRole('button', { name: 'Unstar nested.png', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Back to bundle', exact: true }).click()
    await expect(alphaTile).toBeVisible()

    // 3. File Inspector annotations: Star, Tags (one-way propagation), Note & Source causal save
    await alphaTile.click()
    await expect(fileInspector).toBeVisible()
    await fileInspector.getByRole('button', { name: 'Star file', exact: true }).click()
    await expect(
      fileInspector.getByRole('button', { name: 'Unstar file', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      alphaTile.getByRole('button', { name: 'Unstar alpha.png', exact: true }),
    ).toBeVisible()

    const fileTags = fileInspector.locator('[data-section="file-tags"]')
    const pickFileTag = async (name: string) => {
      await fileTags.getByRole('button', { name: '+ Tag', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Choose tags', exact: true })
      await picker.getByRole('textbox', { name: 'Search tags', exact: true }).fill(name)
      await picker.getByRole('button', { name: new RegExp(`^${name}`) }).click()
      await page.keyboard.press('Escape')
      await expect(
        fileTags.getByRole('button', { name: `Remove ${name}`, exact: true }),
      ).toBeEnabled()
    }
    await pickFileTag('Blue')
    await pickFileTag('Amber')

    const fileNote = fileInspector.getByRole('textbox', { name: 'File note', exact: true })
    await fileNote.fill('Alpha synthetic cobalt note')
    await fileNote.blur()
    await expect(fileInspector.locator('.catalog-inspector-save')).toHaveText('Saved', {
      timeout: 30_000,
    })

    const fileSource = fileInspector.getByRole('textbox', { name: 'File source', exact: true })
    await fileSource.fill('https://example.invalid/synthetic-alpha')
    await fileSource.press('Enter')
    await expect(fileInspector.locator('.catalog-inspector-save')).toHaveText('Saved', {
      timeout: 30_000,
    })

    // Removing Amber from the file keeps Amber on the confirmed parent bundle
    await fileTags.getByRole('button', { name: 'Remove Amber', exact: true }).click()
    await expect(fileTags.getByRole('button', { name: 'Remove Amber', exact: true })).toHaveCount(0)

    // Filter Items with "Blue" from File Inspector closes Album and filters library
    await fileTags.getByRole('button', { name: 'Tag actions Blue', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Filter Items with “Blue”', exact: true }).click()
    await expect(listing).toHaveCount(0)
    await expect(bundlesList.getByRole('option')).toHaveCount(1)
    await expect(multiCard).toBeVisible()
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    // 4. Bundle Inspector: confirmed one-way propagation + Files in bundle row stars & inline details
    await multiCard.click()
    const bundleInspector = page.getByRole('complementary', {
      name: 'Bundle inspector',
      exact: true,
    })
    const bundleTags = bundleInspector.locator('[data-section="tags"]')
    await expect(bundleTags.getByRole('button', { name: 'Remove Blue', exact: true })).toBeVisible()
    await expect(
      bundleTags.getByRole('button', { name: 'Remove Amber', exact: true }),
    ).toBeVisible()

    const bundleFiles = bundleInspector.locator('[data-section="files"]')
    await expect(
      bundleFiles.getByRole('button', { name: 'Unstar Loose/alpha.png', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await bundleFiles.getByRole('button', { name: 'Show files in Gallery', exact: true }).click()
    await expect(
      bundleFiles.getByRole('button', { name: 'Unstar Gallery/nested.png', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    const alphaRow = bundleFiles.getByRole('button', { name: /^alpha\.png/ })
    await alphaRow.click()
    await expect(alphaRow).toHaveAttribute('aria-pressed', 'true')
    // Clicking a row in Files in bundle never appends file metadata at the bottom of the sidebar
    await expect(
      bundleFiles.getByRole('region', { name: 'Local file details', exact: true }),
    ).toHaveCount(0)

    // 5. FTS5 Search finds bundle-multi by file note and file source
    const searchBox = page.getByRole('searchbox', { name: 'Search', exact: true })
    await searchBox.fill('cobalt')
    await expect(bundlesList.getByRole('option')).toHaveCount(1)
    await expect(multiCard).toBeVisible()
    await searchBox.fill('synthetic-alpha')
    await expect(bundlesList.getByRole('option')).toHaveCount(1)
    await expect(multiCard).toBeVisible()
    await searchBox.fill('')
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    // 6. In-Album filtering: Starred flattening, Tag hierarchy + Any/All, empty state
    await multiCard.getByRole('button', { name: 'Open bundle (3 files)', exact: true }).click()
    await expect(listing.locator('[data-file-id="dir-gallery"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-nested"]')).toHaveCount(0)

    // Tag file-beta with "Warm" so the bundle holds both Scene>Blue (file-alpha) and Warm (file-beta)
    await betaTile.click()
    await pickFileTag('Warm')
    await listing.press('Escape')

    await page.getByRole('button', { name: 'Filter bundle by starred files', exact: true }).click()
    await expect(listing.locator('[data-file-id="dir-gallery"]')).toHaveCount(0)
    await expect(listing.locator('[data-file-id="file-alpha"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-nested"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-beta"]')).toHaveCount(0)

    // Parent tag "Scene" matches descendant "Blue" on file-alpha; excludes un-tagged file-nested
    await page.getByRole('button', { name: 'Filter bundle by tags', exact: true }).click()
    const tagFilterDialog = page.getByRole('dialog', { name: 'Filter bundle by tags', exact: true })
    await tagFilterDialog.getByRole('checkbox', { name: 'Scene', exact: true }).check()
    await expect(listing.locator('[data-file-id="file-alpha"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-nested"]')).toHaveCount(0)

    // Add "Warm" with Match: All -> empty state; switch to Any -> file-alpha (and file-beta once Starred is cleared)
    await tagFilterDialog.getByRole('button', { name: 'All', exact: true }).click()
    await tagFilterDialog.getByRole('checkbox', { name: 'Warm', exact: true }).check()
    await expect(page.getByText('No files match these filters.', { exact: true })).toBeVisible()
    await tagFilterDialog.getByRole('button', { name: 'Any', exact: true }).click()
    await expect(listing.locator('[data-file-id="file-alpha"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Filter bundle by starred files', exact: true }).click()
    await expect(listing.locator('[data-file-id="file-alpha"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-beta"]')).toBeVisible()

    // Clear all album filters -> collapsed dir-gallery returns
    await page.getByRole('button', { name: 'Clear album filters', exact: true }).click()
    await expect(listing.locator('[data-file-id="dir-gallery"]')).toBeVisible()
    await expect(listing.locator('[data-file-id="file-nested"]')).toHaveCount(0)

    // Locate in File Browser -> File Inspector parity
    await alphaTile.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Locate in File Browser', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(
      fileInspector.getByRole('button', { name: 'Unstar file', exact: true }),
    ).toBeVisible()
    await expect(
      fileInspector.getByRole('textbox', { name: 'File note', exact: true }),
    ).toHaveValue('Alpha synthetic cobalt note')

    // 7. Reload persistence, library Starred files chip & has_starred_files Smart Collection
    await page.reload()
    await page.getByRole('tab', { name: 'Bundles', exact: true }).click()
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    await page.getByRole('button', { name: 'Filter by starred files', exact: true }).click()
    await expect(bundlesList.getByRole('option')).toHaveCount(1)
    await expect(multiCard).toBeVisible()
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    await page.getByRole('button', { name: 'New smart collection', exact: true }).click()
    const smartDialog = page.getByRole('dialog', { name: 'New Smart Collection', exact: true })
    await smartDialog.getByLabel('Smart collection name').fill('With starred files')
    await smartDialog.getByLabel('Field', { exact: true }).selectOption('has_starred_files')
    await expect(smartDialog.getByText('1 matching bundle', { exact: true })).toBeVisible()
    await smartDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(smartDialog).toHaveCount(0, { timeout: 30_000 })
    await expect(bundlesList.getByRole('option')).toHaveCount(1)
    await expect(multiCard).toBeVisible()
    await page.getByRole('button', { name: /^All( \d+)?$/ }).click()
    await expect(bundlesList.getByRole('option')).toHaveCount(3)

    // 8. Narrow/mobile viewport layout verification (390x844)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
    const noHorizontalOverflow = async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    expect(await noHorizontalOverflow()).toBe(true)

    await multiCard.getByRole('button', { name: 'Open bundle (3 files)', exact: true }).click()
    await expect(listing).toBeVisible()
    await alphaTile.click()
    await expect(fileInspector).toBeVisible()
    await expect(
      fileInspector.getByRole('button', { name: 'Unstar file', exact: true }),
    ).toBeVisible()
    await expect(
      fileInspector.getByRole('textbox', { name: 'File note', exact: true }),
    ).toBeVisible()
    expect(await noHorizontalOverflow()).toBe(true)

    await page.getByRole('button', { name: 'Filter bundle by tags', exact: true }).click()
    await expect(tagFilterDialog).toBeVisible()
    const tagDialogBox = await tagFilterDialog.boundingBox()
    if (!tagDialogBox) throw new Error('Album tag filter dialog box missing')
    expect(tagDialogBox.x).toBeGreaterThanOrEqual(0)
    expect(tagDialogBox.x + tagDialogBox.width).toBeLessThanOrEqual(390)
    expect(await noHorizontalOverflow()).toBe(true)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
    await page.setViewportSize({ width: 1400, height: 1000 })
  } finally {
    await context.close()
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})

test('concurrent replica edits hold and surface review for file note, tag, and star @fullstack', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cairndex-file-conflicts-')))
  const seed = buildFixture(scratch)
  const roots = [join(scratch, 'A'), join(scratch, 'B')]
  await cp(seed, roots[0], { recursive: true })
  await cp(seed, roots[1], { recursive: true })
  const backends = [
    await startBackend(join(scratch, 'private-A')),
    await startBackend(join(scratch, 'private-B')),
  ]
  const contexts = [
    await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
    await browser.newContext({ viewport: { width: 1400, height: 1000 } }),
  ]
  try {
    const libraries = await Promise.all(
      backends.map((backend, index) =>
        apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/register', {
          root_path: roots[index],
        }),
      ),
    )
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    for (let index = 0; index < pages.length; index += 1) {
      await proxyApi(pages[index], backends[index].baseUrl)
      await pages[index].goto('/')
      await openMetadataReview(pages[index])
      await expect(
        pages[index].getByRole('region', { name: 'Metadata delivery status' }),
      ).toContainText('Saved here · available metadata published', { timeout: 30_000 })
      await pages[index].getByRole('button', { name: 'Bundle Browser', exact: true }).click()
    }
    const [a, b] = pages

    const openAlphaInAlbum = async (page: typeof a) => {
      const card = page.locator('[data-bundle-id="bundle-multi"]')
      await card.getByRole('button', { name: 'Open bundle (3 files)', exact: true }).click()
      const listing = page.getByRole('list', { name: 'Album items', exact: true })
      await listing.locator('[data-file-id="file-alpha"]').click()
      return page.getByRole('complementary', { name: 'File inspector', exact: true })
    }

    // 1. Concurrent File Note edits -> hold + Review Conflicts -> Conflicting Edits modal in place
    const inspectorA = await openAlphaInAlbum(a)
    const inspectorB = await openAlphaInAlbum(b)
    for (const [page, text] of [
      [inspectorA, 'Replica A file note'],
      [inspectorB, 'Replica B file note'],
    ] as const) {
      const box = page.getByRole('textbox', { name: 'File note', exact: true })
      await box.fill(text)
      await box.blur()
      await expect(page.locator('.catalog-inspector-save')).toHaveText('Saved', { timeout: 30_000 })
    }
    await exchangeReplicas(roots[0], roots[1])
    await expect(
      inspectorA.getByText('This file has conflicting edits.', { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await inspectorA.getByRole('button', { name: 'Review Conflicts', exact: true }).click()
    const conflictDialog = a.getByRole('dialog', { name: 'Conflicting Edits', exact: true })
    await expect(conflictDialog).toBeVisible({ timeout: 30_000 })
    await expect(a.getByRole('navigation', { name: 'Catalog families' })).toHaveCount(0)
    await expect(conflictDialog.getByText('Replica A file note', { exact: true })).toBeVisible()
    await expect(conflictDialog.getByText('Replica B file note', { exact: true })).toBeVisible()
    await conflictDialog.getByRole('radio', { name: /Replica A file note/ }).check()
    await conflictDialog.getByRole('button', { name: 'Keep Selected', exact: true }).click()
    await expect(conflictDialog).toHaveCount(0)
    await expect(inspectorA.getByRole('textbox', { name: 'File note', exact: true })).toHaveValue(
      'Replica A file note',
      { timeout: 30_000 },
    )
    // Open Bundle Album and selected file remain intact without re-navigating
    const listingA = a.getByRole('list', { name: 'Album items', exact: true })
    await expect(listingA).toBeVisible()

    await exchangeReplicas(roots[0], roots[1])
    await expect
      .poll(
        async () => {
          const res = await fetch(
            `${backends[1].baseUrl}/api/v1/libraries/${libraries[1].id}/replica/catalog/entities/asset_files/file-alpha`,
          )
          const entity = (await res.json()) as {
            has_conflicts: boolean
            fields: { note: { value: string } }
          }
          return !entity.has_conflicts && entity.fields.note.value === '"Replica A file note"'
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    // 2. Concurrent File Tag add (A) vs Tag delete (B) -> focused Conflict Review + recovery -> returns to open Album
    const fileTags = inspectorA.locator('[data-section="file-tags"]')
    await fileTags.getByRole('button', { name: '+ Tag', exact: true }).click()
    const picker = a.getByRole('dialog', { name: 'Choose tags', exact: true })
    await picker.getByRole('textbox', { name: 'Search tags', exact: true }).fill('Blue')
    await picker.getByRole('button', { name: /^Blue/ }).click()
    await a.keyboard.press('Escape')
    await expect(fileTags.getByRole('button', { name: 'Remove Blue', exact: true })).toBeVisible()

    await runPreviewAndCommit(backends[1].baseUrl, libraries[1].id, {
      action: 'delete',
      family: 'tags',
      entity: 'tags-blue',
      cascade: true,
    })
    await exchangeReplicas(roots[0], roots[1])

    await expect(
      fileTags.getByText('Tag “Blue” has conflicting edits.', { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    })
    await fileTags.getByRole('button', { name: 'Review Conflict', exact: true }).click()
    const review = a.getByRole('region', { name: 'Complete conflict review', exact: true })
    await expect(review).toBeVisible({ timeout: 30_000 })
    await expect(
      a.getByRole('heading', { name: 'Conflict Review · Tag “Blue” on “alpha.png”', exact: true }),
    ).toBeVisible()
    await expect(a.getByRole('navigation', { name: 'Catalog families' })).toHaveCount(0)
    await expect(
      review.getByRole('group', { name: 'Tag “Blue” on “alpha.png”', exact: true }),
    ).toBeVisible()
    const tagGroup = review.getByRole('group', { name: 'Tag “Blue”', exact: true })
    await expect(tagGroup).toBeVisible()
    await tagGroup.getByRole('radio', { name: /Keep in library/ }).check()
    await review
      .getByRole('checkbox', {
        name: /Explicitly restore a deleted identity/,
      })
      .check()
    await review.getByRole('button', { name: 'Prepare choice', exact: true }).click()
    await a.getByRole('button', { name: 'Apply reviewed operation', exact: true }).click()

    // Automatically returns to the open Bundle Album with file-alpha and restored Blue tag
    await expect(listingA).toBeVisible({ timeout: 30_000 })
    await expect(fileTags.getByRole('button', { name: 'Remove Blue', exact: true })).toBeVisible()

    // 3. Concurrent File Star (A) vs File Delete (B) -> focused Conflict Review + explicit return to Album
    const betaA = listingA.locator('[data-file-id="file-beta"]')
    await expect(betaA).toBeVisible()
    await betaA.click()
    const inspectorA3 = a.getByRole('complementary', { name: 'File inspector', exact: true })
    await betaA.getByRole('button', { name: 'Star beta.png', exact: true }).click()
    await expect(betaA.getByRole('button', { name: 'Unstar beta.png', exact: true })).toBeVisible()

    await runPreviewAndCommit(backends[1].baseUrl, libraries[1].id, {
      action: 'delete',
      family: 'asset_files',
      entity: 'file-beta',
    })
    await exchangeReplicas(roots[0], roots[1])

    await expect(
      inspectorA3.getByText('This file star has conflicting edits.', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    const starConflictAlert = inspectorA3
      .getByRole('alert')
      .filter({ hasText: 'This file star has conflicting edits.' })
    await starConflictAlert.getByRole('button', { name: 'Review Conflict', exact: true }).click()
    await expect(review).toBeVisible({ timeout: 30_000 })
    await expect(
      a.getByRole('heading', { name: 'Conflict Review · Star on “beta.png”', exact: true }),
    ).toBeVisible()
    await expect(review.getByRole('group', { name: 'File “beta.png”', exact: true })).toBeVisible()
    await a.getByRole('button', { name: '‹ Back to Bundle Album', exact: true }).click()
    await expect(listingA).toBeVisible()
    await expect(inspectorA3).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(backends.map((backend) => stopBackend(backend.child)))
    await rm(scratch, { recursive: true, force: true })
  }
})
