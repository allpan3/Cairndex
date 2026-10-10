import { type Page } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
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
export async function startBackend(dataDir: string, environment: Record<string, string> = {}) {
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
          ...environment,
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
export async function stopBackend(child: ChildProcessWithoutNullStreams) {
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
export async function proxyApi(page: Page, apiBaseUrl: string) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    try {
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
      let body: Buffer
      try {
        body = Buffer.from(await response.arrayBuffer())
      } catch {
        // The server ends a started media response when its source file moves or
        // changes. A browser connected directly then sees a reset connection, so the
        // proxy gives the page the same result instead of failing the test.
        await route.abort('connectionreset')
        return
      }
      await route.fulfill({ status: response.status, headers, body })
    } catch (error) {
      // Media replacement can cancel a routed range while its upstream read is still settling
      if (
        !page.isClosed() &&
        !request.failure() &&
        !String(error).includes('Route is already handled')
      )
        throw error
    }
  })
}

/** Sequential synthetic setup explicitly reads before authoring; race tests retain their own bases */
export async function apiPost<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const url = `${baseUrl}${path}`
  const library = url.match(/^(.*\/api\/v1\/libraries\/[^/]+)\//)?.[1]
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (library) {
    const read = await fetch(`${library}/metadata`)
    if (read.ok) {
      headers['X-Cairndex-Basis'] = ((await read.json()) as { basis: string }).basis
      headers['X-Cairndex-Operation'] = crypto.randomUUID()
    }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`)
  return (await response.json()) as T
}
