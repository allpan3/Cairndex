import { expect, test } from 'vitest'
import type { FileSuggestion } from '../api/client'
import { fileChoiceKey, withFileChoices } from './manualFileChoices'

function choice(path: string, id: string | null): FileSuggestion {
  return {
    file_id: id,
    relative_path: path,
    media_kind: 'video',
    confidence: 1,
    reason: 'Synthetic',
  }
}

test('mixed choices preserve catalog IDs and private paths across pages without duplicates', () => {
  const observed = choice('Fresh/scene.mp4', null)
  const retained = choice('Retained/scene.mp4', 'retained')
  expect(fileChoiceKey(observed)).not.toBe(fileChoiceKey(retained))
  expect(
    withFileChoices({ fileIds: ['retained'], relativePaths: ['Fresh/scene.mp4'] }, [
      retained,
      observed,
      choice('Later/scene.mp4', null),
    ]),
  ).toEqual({ fileIds: ['retained'], relativePaths: ['Fresh/scene.mp4', 'Later/scene.mp4'] })
})
