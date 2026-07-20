import type { HostPlatform } from './index'

// Plain-browser host implementation with every native capability disabled
export const webPlatform: HostPlatform = {
  kind: 'web',
  canRevealInFinder: false,
  canOpenWithDefaultApp: false,
  canDragOutFiles: false,
  canSaveExports: false,
  revealFile: async () => undefined,
  openFile: async () => undefined,
  startFileDrag: async () => undefined,
  getLibraryMapping: async () => null,
  locateLibrary: async () => null,
  clearLibraryMapping: async () => undefined,
  saveExport: async () => null,
}
