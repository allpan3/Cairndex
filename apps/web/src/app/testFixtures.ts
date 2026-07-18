import type { FileBrowserEntry } from '../api/client'

/** One canonical linked, supported video file entry for host-action tests. */
export const linkedVideoEntry: FileBrowserEntry = {
  audio_codec: null,
  bundle_id: 'bundle-one',
  container: 'mov,mp4',
  created_at: '2026-07-18T00:00:00Z',
  duration: 60,
  extension: 'mp4',
  file_id: 'file-one',
  kind: 'file',
  linked: true,
  media_kind: 'video',
  mime_type: 'video/mp4',
  modified_at: '2026-07-18T00:00:00Z',
  name: 'movie.mp4',
  relative_path: 'Movies/movie.mp4',
  resume_position: 0,
  size_bytes: 100,
  supported: true,
  unbundled: false,
  video_codec: 'h264',
}
