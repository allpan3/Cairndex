import type { FileRead } from '../../api/client'
import { fileContentUrl } from '../../api/client'

/** M2 image stage: simple full-image rendering; zoom/pan lands in M5. */
export function ImageStage({ file, onError }: { file: FileRead; onError: () => void }) {
  return (
    <img
      className="mv-image"
      src={fileContentUrl(file.id)}
      alt={file.display_title}
      draggable={false}
      onError={onError}
    />
  )
}
