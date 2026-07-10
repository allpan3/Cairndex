const BROWSER_NATIVE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

// Return the lowercase extension used for browser-native image decisions
export function imageExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

// True when the browser can display the source bytes directly
export function isBrowserNativeImage(path: string): boolean {
  return BROWSER_NATIVE_IMAGE_EXTENSIONS.has(imageExtension(path))
}
