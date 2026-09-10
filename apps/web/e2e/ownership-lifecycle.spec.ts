import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Reserve an ephemeral localhost port for a throwaway backend. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve backend port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

/** Start a real isolated Cairndex server for the pairing flow. */
async function startBackend(dataDir: string) {
  const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))
  let lastOutput = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const child = spawn(
      'uv',
      ['run', 'uvicorn', 'cairndex.main:app', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: serverDir,
        env: {
          ...process.env,
          CAIRNDEX_DATA_DIR: dataDir,
          CAIRNDEX_WORKER_ENABLED: 'false',
        },
        stdio: 'pipe',
      },
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const readyLine = `Uvicorn running on http://127.0.0.1:${port}`
    const started = Date.now()
    while (Date.now() - started < 30_000) {
      if (child.exitCode !== null || child.signalCode !== null) break
      if (output.includes(readyLine)) {
        try {
          const response = await fetch(`${baseUrl}/api/v1/health`)
          if (response.ok) return { baseUrl, child }
        } catch {
          // Uvicorn can log its socket just before the route accepts requests
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    lastOutput = output
    await stopBackend(child)
  }
  throw new Error(`backend did not start: ${lastOutput.slice(-500)}`)
}

/** Stop the throwaway backend without leaving a child process. */
async function stopBackend(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Proxy page-relative API requests to the random backend port. */
async function proxyApi(page: Page, apiBaseUrl: string) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    const response = await fetch(`${apiBaseUrl}${source.pathname}${source.search}`, {
      method: request.method(),
      headers: request.headers(),
      body: ['GET', 'HEAD'].includes(request.method())
        ? undefined
        : (request.postDataBuffer() ?? undefined),
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key)) headers[key] = value
    })
    await route.fulfill({
      status: response.status,
      headers,
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
}

/** Send JSON directly from the simulated device side. */
async function apiPost<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`)
  return (await response.json()) as T
}

test('release and reopen through the real server without automatic reacquisition @fullstack', async ({
  page,
}) => {
  const scratch = await mkdtemp(join(tmpdir(), 'cairndex-ownership-e2e-'))
  const backend = await startBackend(join(scratch, 'state'))
  try {
    const library = await apiPost<{ id: string }>(backend.baseUrl, '/api/v1/libraries/create', {
      root_path: join(scratch, 'library'),
      display_name: 'Synthetic Lifecycle',
      create_if_missing: true,
    })
    await proxyApi(page, backend.baseUrl)
    await page.goto('/')
    await page.getByRole('button', { name: 'Manage libraries' }).click()
    await page.getByRole('button', { name: 'Release', exact: true }).click()
    await expect(page.getByText('Released on this server', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByText('Library released on this server', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Library released on this server', { exact: true })).toBeVisible()
    const browse = `${backend.baseUrl}/api/v1/libraries/${library.id}/bundles/browse`
    expect((await fetch(browse)).status).toBe(409)
    await page.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(
      page.getByText('Library released on this server', { exact: true }),
    ).not.toBeVisible()
    expect((await fetch(browse)).status).toBe(200)
    // Closing a remote client must not issue a server release
    await page.goto('about:blank')
    const status = await fetch(`${backend.baseUrl}/api/v1/libraries/${library.id}/ownership`)
    expect((await status.json()).state).toBe('own')
  } finally {
    await stopBackend(backend.child)
    await rm(scratch, { recursive: true, force: true })
  }
})
