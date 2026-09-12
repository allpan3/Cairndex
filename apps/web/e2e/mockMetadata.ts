// Hermetic UI fixtures expose a synthetic read basis; real backend tests verify clock enforcement
export const METADATA_REPLY = {
  headers: { 'X-Cairndex-Basis': `${'a'.repeat(32)}:0:${'b'.repeat(32)}:0` },
}
