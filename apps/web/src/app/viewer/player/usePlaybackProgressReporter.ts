import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  beaconPlaybackProgress,
  updatePlaybackProgress,
  type PlaybackManifest,
  type PlaybackProgressUpdate,
} from '../../../api/client'
import type { PlayerStatus } from './usePlayer'

const REPORT_INTERVAL_MS = 10_000
const MIN_REPORT_POSITION_S = 0.25

interface ProgressReporterOptions {
  bundleId: string | null
  fileId: string | null
  enabled: boolean
  status: PlayerStatus
  currentTime: number
  duration: number
  completed?: boolean | null
}

// Keep server-side resume progress current for one playable video
export function usePlaybackProgressReporter({
  bundleId,
  fileId,
  enabled,
  status,
  currentTime,
  duration,
  completed = false,
}: ProgressReporterOptions) {
  const qc = useQueryClient()
  const stateRef = useRef({ fileId, enabled, status, currentTime, duration, completed })
  const lastSentRef = useRef<{ fileId: string; position: number } | null>(null)
  const lastCompletedRef = useRef<{ fileId: string; completed: boolean } | null>(
    fileId ? { fileId, completed: Boolean(completed) } : null,
  )
  const previousStatusRef = useRef(status)

  useEffect(() => {
    stateRef.current = { fileId, enabled, status, currentTime, duration, completed }
  }, [completed, currentTime, duration, enabled, fileId, status])

  useEffect(() => {
    lastCompletedRef.current = fileId ? { fileId, completed: Boolean(completed) } : null
  }, [completed, fileId])

  const payload = useCallback((force = false): [string, PlaybackProgressUpdate] | null => {
    const current = stateRef.current
    if (!current.enabled || !current.fileId) return null
    if (!Number.isFinite(current.currentTime) || current.currentTime <= MIN_REPORT_POSITION_S)
      return null
    const safeDuration =
      Number.isFinite(current.duration) && current.duration > 0 ? current.duration : null
    const body = { position_s: current.currentTime, duration_s: safeDuration }
    const last = lastSentRef.current
    if (
      !force &&
      last?.fileId === current.fileId &&
      Math.abs(last.position - body.position_s) < MIN_REPORT_POSITION_S
    )
      return null
    lastSentRef.current = { fileId: current.fileId, position: body.position_s }
    return [current.fileId, body]
  }, [])

  const flush = useCallback(
    (force = false, invalidateAfter = false) => {
      const next = payload(force)
      if (!next) {
        if (invalidateAfter) qc.invalidateQueries({ queryKey: ['continue-watching'] })
        return
      }
      const [nextFileId, body] = next
      void Promise.resolve(updatePlaybackProgress(nextFileId, body)).then((progress) => {
        const previousCompleted =
          lastCompletedRef.current?.fileId === nextFileId
            ? lastCompletedRef.current.completed
            : Boolean(stateRef.current.completed)
        const completedChanged = previousCompleted !== progress.completed
        lastCompletedRef.current = { fileId: nextFileId, completed: progress.completed }
        if (bundleId) {
          qc.setQueryData<PlaybackManifest>(['playback', bundleId], (previous) =>
            previous
              ? {
                  ...previous,
                  videos: previous.videos.map((video) =>
                    video.file_id === nextFileId ? { ...video, progress } : video,
                  ),
                }
              : previous,
          )
        }
        if (completedChanged || invalidateAfter) {
          qc.invalidateQueries({ queryKey: ['continue-watching'] })
        }
      })
    },
    [bundleId, payload, qc],
  )

  useEffect(() => {
    if (!enabled || status !== 'playing') return
    const interval = window.setInterval(() => flush(false), REPORT_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [enabled, flush, status])

  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = status
    if (previous === 'playing' && (status === 'paused' || status === 'ended')) {
      flush(true)
    }
  }, [flush, status])

  useEffect(() => {
    const onPageHide = () => {
      const next = payload(true)
      if (!next) return
      const [nextFileId, body] = next
      beaconPlaybackProgress(nextFileId, body)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      flush(true, true)
    }
  }, [flush, payload])
}
