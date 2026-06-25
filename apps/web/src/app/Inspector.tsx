import { thumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles } from '../api/hooks'
import { formatBytes, formatDate, formatDimensions, formatDuration } from '../lib/format'

function Stars({ rating }: { rating: number | null }) {
  const value = rating ?? 0
  return (
    <span className={`stars${value === 0 ? ' stars--empty' : ''}`}>
      {'★★★★★'.slice(0, value)}
      {'☆☆☆☆☆'.slice(0, 5 - value)}
    </span>
  )
}

export function Inspector({ bundleId }: { bundleId: string | null }) {
  const { data: bundle } = useBundle(bundleId)
  const { data: files } = useBundleFiles(bundleId)

  if (bundleId === null) {
    return (
      <aside className="inspector">
        <div className="state">Select a bundle to see its details.</div>
      </aside>
    )
  }

  return (
    <aside className="inspector">
      <div
        className="inspector__cover"
        style={{ backgroundImage: `url(${thumbnailUrl(bundleId)})` }}
      />
      <h2 className="inspector__title">{bundle?.title ?? 'Untitled'}</h2>

      <div className="prop">
        <span className="prop__k">Rating</span>
        <span className="prop__v">
          <Stars rating={bundle?.rating ?? null} />
        </span>
      </div>
      {bundle?.source_url && (
        <div className="prop">
          <span className="prop__k">Source</span>
          <a className="prop__v" href={bundle.source_url} target="_blank" rel="noreferrer">
            link
          </a>
        </div>
      )}
      <div className="prop">
        <span className="prop__k">Files</span>
        <span className="prop__v">{files?.length ?? 0}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Size</span>
        <span className="prop__v">
          {formatBytes(files?.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0) ?? 0)}
        </span>
      </div>
      {bundle && (
        <div className="prop">
          <span className="prop__k">Date Added</span>
          <span className="prop__v">{formatDate(bundle.created_at)}</span>
        </div>
      )}
      {bundle?.note && (
        <div className="prop" style={{ display: 'block' }}>
          <div className="prop__k">Note</div>
          <div style={{ marginTop: 4 }}>{bundle.note}</div>
        </div>
      )}

      <div className="files">
        <div className="sidebar__heading" style={{ padding: '4px 0' }}>
          Files in bundle
        </div>
        {files?.map((f) => {
          const meta = (f.tech_metadata ?? {}) as Record<string, unknown>
          const dims = formatDimensions(meta.width as number, meta.height as number)
          const dur = formatDuration(meta.duration as number)
          return (
            <div className="file-row" key={f.id}>
              <div>
                <div>{f.display_title}</div>
                <div className="file-row__role">
                  {f.role} · {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(f.size_bytes)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
