import type { FileSelection, FileSuggestion } from '../api/client'

/** UI keys keep a private observed path separate from a real catalog identity. */
export function fileChoiceKey(file: FileSuggestion): string {
  return file.file_id ? `id:${file.file_id}` : `path:${file.relative_path}`
}

export function withFileChoices(
  seed: FileSelection,
  choices: Iterable<FileSuggestion>,
): FileSelection {
  const ids = new Set(seed.fileIds ?? [])
  const paths = new Set(seed.relativePaths ?? [])
  for (const file of choices) {
    if (file.file_id) ids.add(file.file_id)
    else paths.add(file.relative_path)
  }
  return {
    ...seed,
    fileIds: [...ids],
    ...(paths.size ? { relativePaths: [...paths] } : {}),
  }
}
