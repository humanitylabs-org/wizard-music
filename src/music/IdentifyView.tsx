import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { identifyControl, identifyJson, IDENTIFY_TARGET_SECONDS, IDENTIFY_LIMIT_SECONDS, type Candidate } from './identify'
import './identify.css'

declare global { interface Window { WzSheet: { open(dialog: HTMLDialogElement): void; close(dialog: HTMLDialogElement): void } } }
const time = (s: string) => new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const label = (s: string) => ({ pending: 'Saved · identifying…', uploaded: 'Saved · identifying…', hunting: 'Saved · identifying…', has_leads: 'Possible matches', resolved: 'Confirmed', no_match: 'No match · audio kept', error: 'Try again · audio kept' }[s] || s)

export function IdentifyButtons() {
  const state = useSyncExternalStore(identifyControl.subscribe, identifyControl.snapshot)
  return <div className="identify-header"><button type="button" className="wz-button secondary" onClick={() => { flushSync(() => { void identifyControl.start() }) }} disabled={state.phase !== 'idle'} aria-label="Identify song">◉ <span>Identify</span></button><button type="button" className="wz-button secondary" onClick={() => identifyControl.open()}>Identifications</button></div>
}
// Clean Shazam fingerprints often match from a few seconds. Wang (2003) shows
// 10–15 s clips robust in heavy noise where 5 s clips drop off: 12 s is our
// loud-room "enough" target, never an auto-send timer. The separate hard cap is 30 s.
export function CaptureProgress({ elapsed }: { elapsed: number }) {
  const copy = elapsed < 4 ? 'Hold it up to the music…' : elapsed < 8 ? 'Catching the beat…' : elapsed < 12 ? 'Almost there, keep it steady…' : 'That should be enough to find it. Keep listening a bit longer to boost the odds.'
  return <><div className="identify-ring" role="progressbar" aria-label="Audio capture target" aria-valuemin={0} aria-valuemax={12} aria-valuenow={Math.min(12, elapsed)}><svg viewBox="0 0 120 120" aria-hidden="true"><circle className="identify-ring-track" cx="60" cy="60" r="54" /><circle className="identify-ring-fill" cx="60" cy="60" r="54" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - Math.min(1, elapsed / IDENTIFY_TARGET_SECONDS)} /></svg><strong>{Math.floor(elapsed)}<small>seconds</small></strong></div><p className="identify-guidance">{copy}</p></>
}
function Clip({ src }: { src: string }) { return <audio key={src} controls preload="metadata" src={src} /> }
export function IdentifyView({ notify }: { notify(message: string): void }) {
  const state = useSyncExternalStore(identifyControl.subscribe, identifyControl.snapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(''), [query, setQuery] = useState(''), [results, setResults] = useState<Candidate[]>([]), [manual, setManual] = useState(false), [title, setTitle] = useState(''), [artist, setArtist] = useState('')
  const queryGeneration = useRef(0)
  const detail = state.detail
  const local = state.locals.find(c => c.id === state.selected)
  const [localUrl, setLocalUrl] = useState('')
  const [preparedShare, setPreparedShare] = useState<File | null>(null)
  useEffect(() => { if (!local) { setLocalUrl(''); return }; const url = URL.createObjectURL(local.blob); setLocalUrl(url); return () => URL.revokeObjectURL(url) }, [local])
  useEffect(() => {
    setResults([]); setQuery(''); setPreparedShare(null); setPending(''); setManual(false); queryGeneration.current++
    const d = dialog.current
    if (state.selected && d) { window.WzSheet.open(d); const close = () => identifyControl.closeDetail(); d.addEventListener('close', close); return () => {
      d.removeEventListener('close', close); window.WzSheet.close(d)
      // React removes the sheet before its async 'close' event, so release its Back step here; a stale step would swallow the next Back.
      const sheet = d as HTMLDialogElement & { __wzBack?: { release(): void } | null }; const step = sheet.__wzBack; sheet.__wzBack = null; step?.release()
    } }
  }, [state.selected])
  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (pending) return
    setPending(key)
    try { await fn() } catch (e) { notify((e as Error).message) } finally { setPending('') }
  }
  const doSearch = async (q: string) => {
    const gen = ++queryGeneration.current
    setQuery(q); setResults([])
    if (!q.trim()) return
    try { const r = await identifyJson<{ candidates: Candidate[] }>('search?q=' + encodeURIComponent(q)); if (gen === queryGeneration.current) setResults(r.candidates) } catch (e) { if (gen === queryGeneration.current) notify((e as Error).message) }
  }
  const candidates = detail?.candidates || []
  const queued = state.locals.filter(c => !state.hunts.some(h => h.id === c.id))
  return <>
    {state.open && <section className="identify-view" aria-label="Song identification">
      <div className="identify-top"><button className="wz-button secondary" onClick={() => identifyControl.back()}>← Music</button><h2>Identifications</h2><button className="wz-button secondary" onClick={() => { void identifyControl.drain() }}>Refresh</button></div>
      {state.phase !== 'idle' ? <section className="identify-recording" role="status" aria-live="polite">
        {state.phase === 'recording' ? <CaptureProgress elapsed={state.elapsed} /> : <p>{state.phase === 'starting' ? 'Starting microphone…' : state.phase === 'ready' ? 'Recording saved · ready to send' : 'Saving your clip…'}</p>}
        <meter min={0} max={1} value={state.level} aria-label="Microphone level" />
        <div className="identify-actions"><button className="wz-button" disabled={!['recording', 'ready'].includes(state.phase)} onClick={() => { flushSync(() => { void identifyControl.stop() }) }}>{state.elapsed < 5 ? 'Find it now · early' : 'Find it'}</button><button className="wz-button secondary" disabled={state.phase === 'saving'} onClick={() => identifyControl.cancel()}>Cancel</button></div>
        <p className="identify-muted">You can send early. Recording stops at {IDENTIFY_LIMIT_SECONDS} seconds and sends it for identification.</p>
        <p className="identify-muted">Your audio is kept even when there's no match.</p>
      </section> : <button className="wz-button" onClick={() => { flushSync(() => { void identifyControl.start() }) }}>{state.needsTap ? 'Tap to start listening' : '◉ Identify a song'}</button>}
      {state.error && <p role="alert" className="identify-error">{state.error}</p>}
      {state.phase === 'idle' && <div className="identify-manual"><input className="wz-input" aria-label="Note for next recording" placeholder="Optional note · venue, DJ, moment" value={state.note} onChange={e => identifyControl.configure(e.target.value, state.geoEnabled)} /><label><input type="checkbox" checked={state.geoEnabled} onChange={e => identifyControl.configure(state.note, e.target.checked)} /> Save approximate location for the next identification</label></div>}
      <h3>Your identifications</h3>
      {queued.map(c => <button className={'identify-hunt' + (state.freshId === c.id ? ' identify-fresh' : '')} key={c.id} onClick={() => { void identifyControl.detail(c.id) }}><span className="identify-hunt-copy"><strong>Unknown song</strong><span>{time(c.client_ts)} · Saved on this device · {c.sendRequested === false ? 'Not sent · tap to review' : state.sendErrors[c.id] || 'waiting for connection'}</span></span><span>{state.freshId === c.id && <small className="identify-new">New</small>} ›</span></button>)}
      {state.hunts.map(c => <button className={'identify-hunt' + (state.freshId === c.id ? ' identify-fresh' : '')} key={c.id} onClick={() => { void identifyControl.detail(c.id) }}><span className="identify-hunt-copy"><strong>{c.status === 'resolved' ? '✓ ' : ''}{c.best_title || 'Unknown song'}</strong><span>{c.best_artist ? c.best_artist + ' · ' : ''}{time(c.created_at)} · {label(c.status)}</span></span><span>{state.freshId === c.id && <small className="identify-new">New</small>} ›</span></button>)}
      {!state.hunts.length && !queued.length && <p className="wz-empty">{state.loading ? 'Loading identifications…' : 'Hear something? Tap Identify. Every clip is kept.'}</p>}
      <div className="identify-footer"><button className="wz-button secondary" onClick={() => { void act('retry-all', () => identifyControl.retryUnsolved()) }} disabled={!!pending}>{pending === 'retry-all' ? 'Queued…' : 'Retry all unsolved'}</button><button className="wz-button secondary" onClick={() => { void act('retention', async () => { const result = await identifyJson<{ to_archive: string[]; to_delete_audio: string[] }>('retention/dry-run'); notify(`Retention dry-run only · ${result.to_archive?.length || 0} eligible for archive · no audio deleted`) }) }}>Retention dry-run</button></div>
    </section>}
    {state.selected && createPortal(<dialog ref={dialog} className="wz-sheet identify-sheet" aria-label="Identification details">
      <h2>Identification{detail ? ' · ' + time(detail.created_at) : ''}</h2>
      {state.error && <p role="alert">{state.error}</p>}
      <div className="identify-live-status" role="status" aria-live="polite">
        {state.phase === 'saving' ? <><strong>Saving your clip…</strong><p>Keeping the audio on this device first.</p></> : local ? <><strong>{local.sendRequested === false || state.sendErrors[local.id] ? 'Saved on this device' : 'Sending your clip…'}</strong><p>{local.sendRequested === false ? 'Not sent. You can review or send it below.' : state.sendErrors[local.id] || 'Your audio is safe here while it uploads.'}</p>{state.sendErrors[local.id] && <button className="wz-button" onClick={() => { void identifyControl.drain() }}>Try again</button>}</> : !detail || ['pending', 'uploaded', 'hunting'].includes(detail.status) ? <><span className="music-wheel" aria-hidden="true" /><strong>Finding your track…</strong><p>About 6 seconds in our last check. Noisy clips can take longer.</p></> : <strong>{detail.status === 'no_match' ? 'No match this time · audio kept' : detail.status === 'error' ? 'Couldn’t finish this identification · audio kept' : label(detail.status)}</strong>}
      </div>
      {(detail || local) && <>
        <h3>Your audio</h3><Clip src={localUrl || detail?.audio_url || ''} />
        {local && <><p className="identify-muted" role="status">{local.sendRequested === false ? 'Saved on this device · not sent.' : state.sendErrors[local.id] || 'Saved · sending for identification…'}</p>{local.sendRequested === false && <button className="wz-button" disabled={state.phase === 'saving'} onClick={() => { void identifyControl.submit(local.id) }}>Send for identification</button>}</>}
        {detail && <><p className="identify-muted">{label(detail.status)}{detail.note ? ' · ' + detail.note : ''}</p>{detail.last_error && <p role="alert">{detail.last_error}</p>}
          <details><summary>Capture details</summary><p className="identify-muted">SHA-256: <code style={{overflowWrap:'anywhere'}}>{detail.raw_sha256}</code></p></details>
          <details><summary>Original recording</summary><Clip src={detail.original_url || ''} /></details>
          <h3>Possible matches</h3>
          {!candidates.length && !['pending', 'uploaded', 'hunting'].includes(detail.status) && <p>No match yet. Try again below; the audio is safe.</p>}
          {candidates.map(c => <article className={'identify-candidate ' + (c.verdict === 'rejected' ? 'identify-rejected' : '')} key={c.id}>
            <div className="identify-candidate-title">{c.art_url && <img alt="" src={c.art_url} />}<div><strong>{c.title}</strong><p>{c.artist} · {c.provider}</p></div></div>
            <div className="identify-actions"><button className="wz-button secondary" disabled={!!pending} onClick={() => { void act('play-' + c.id, () => identifyControl.play(c)) }}>{pending === 'play-' + c.id ? 'Finding full song…' : 'Play'}</button>
              <button className="wz-button" disabled={!!pending || c.verdict === 'confirmed'} onClick={() => { void act('confirm-' + c.id, async () => { await identifyControl.verdict(c, 'confirmed'); notify('Liked · saved in Music') }) }}>{pending === 'confirm-' + c.id ? 'Saving…' : c.verdict === 'confirmed' ? '✓ Confirmed' : 'This is it'}</button>
              <button className="wz-button secondary" disabled={!!pending} onClick={() => { void act('reject-' + c.id, () => identifyControl.verdict(c, 'rejected')) }}>Not it</button>
              <button className="wz-button secondary" disabled={!!pending} onClick={() => { void act('download-' + c.id, async () => { await identifyJson(`candidates/${c.id}/download`, {}); notify('Downloaded to your library') }) }}>{pending === 'download-' + c.id ? 'Downloading…' : 'Download to library'}</button>
            </div>{c.compare_url && <details><summary>Compare 30-second preview</summary><Clip src={c.compare_url} /></details>}
          </article>)}
          <h3>Not listed?</h3><form className="identify-search" onSubmit={e => { e.preventDefault(); void doSearch(query) }}><input className="wz-input" aria-label="Search title or artist" placeholder="Search title or artist" value={query} onChange={e => { setQuery(e.target.value); queryGeneration.current++; setResults([]) }} /><button className="wz-button secondary" type="submit">Search</button></form>
          {results.map((c, i) => <button className="identify-hunt" key={i} disabled={!!pending} onClick={() => { void act('add-' + i, async () => { await identifyControl.add(detail.id, c); setResults([]) }) }}><span>{c.title} · {c.artist}</span><span>Add</span></button>)}
          <button className="wz-button secondary" onClick={() => setManual(!manual)}>Add manually</button>
          {manual && <form className="identify-manual" onSubmit={e => { e.preventDefault(); void act('manual', async () => { await identifyControl.add(detail.id, { title, artist }); setManual(false) }) }}><input className="wz-input" required aria-label="Song title" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} /><input className="wz-input" aria-label="Artist" placeholder="Artist" value={artist} onChange={e => setArtist(e.target.value)} /><button className="wz-button secondary" disabled={!!pending}>Add candidate</button></form>}
          <div className="identify-footer"><button className="wz-button secondary" disabled={!!pending} onClick={() => { void act('retry', () => identifyControl.retry(detail.id)) }}>{pending === 'retry' ? 'Queued…' : 'Try again'}</button>
            <button className="wz-button secondary" disabled={!!pending} onClick={() => { if (preparedShare) { void window.WizardApp.share?.file(preparedShare, { title: 'Know this song? · Wizard Music' }).then(r => { if (r === 'unsupported') notify('Sharing unavailable. Use Download clip.'); else if (r === 'copied') notify('Copied') }); return }; void act('share', async () => { const r = await fetch(detail.export_url || detail.audio_url || ''); if (!r.ok) throw new Error('Clip unavailable'); const blob = await r.blob(); setPreparedShare(new File([blob], `hunt-${detail.id}.mp3`, { type: blob.type })); notify('Clip ready · tap Share clip') }) }}>{preparedShare ? 'Share clip' : pending === 'share' ? 'Preparing…' : 'Export clip'}</button><a className="wz-button secondary" href={detail.export_url || detail.audio_url} download>Download clip</a></div>
          <details><summary>Attempts ({detail.attempts?.length || 0})</summary>{detail.attempts?.map(a => <p className="identify-muted" key={a.id}>{a.provider} · {a.outcome} · {a.preprocess}{a.error ? ' · ' + a.error : ''}</p>)}</details>
        </>}
      </>}
    </dialog>, document.body)}
  </>
}
