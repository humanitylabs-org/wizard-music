import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { identifyControl, identifyJson, IDENTIFY_TARGET_SECONDS, IDENTIFY_LIMIT_SECONDS, type Candidate } from './identify'
import './identify.css'

declare global { interface Window { WzSheet: { open(dialog: HTMLDialogElement): void; close(dialog: HTMLDialogElement): void } } }
const time = (s: string) => new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const label = (s: string) => ({ pending: 'Saved · identifying…', uploaded: 'Saved · identifying…', hunting: 'Saved · identifying…', has_leads: 'Possible matches', resolved: 'Confirmed', no_match: 'No match · audio kept', error: 'Try again · audio kept' }[s] || s)
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const WAITING = ['pending', 'uploaded', 'hunting']
/** Paint the listening stage on the tap itself; the shared capture permission settles after. */
const listen = () => { flushSync(() => { void identifyControl.start() }) }

/** Five sound bars: the identify mark. While listening they follow the microphone level. */
const ListenGlyph = () => <svg className="identify-glyph" viewBox="0 0 48 48" aria-hidden="true">{[12, 22, 30, 22, 12].map((h, i) => <rect key={i} x={7.75 + i * 7.5} y={24 - h / 2} width="4.5" height={h} rx="2.25" />)}</svg>
const ChevronLeft = () => <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
const ChevronRight = () => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
const RefreshGlyph = () => <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
const NoteGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h4L19.5 8.5a2.1 2.1 0 0 0-3-3L6 16v3Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /></svg>
const CheckGlyph = () => <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4 4 9-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
const NoteMark = () => <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
const PlayMark = () => <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5L7 4.5Z" fill="currentColor" /></svg>

/** Home's one way in: tap to identify (or return to a recording in progress); history is the quiet link beside it. */
export function IdentifyEntry() {
  const state = useSyncExternalStore(identifyControl.subscribe, identifyControl.snapshot)
  const active = state.phase !== 'idle'
  return <div className="identify-entry">
    <button type="button" className="identify-entry-main" aria-label={active ? 'Return to listening' : 'Identify song'} onClick={listen}>
      <span className={'identify-entry-orb' + (active ? ' live' : '')}><ListenGlyph /></span>
      <span className="identify-entry-copy"><strong>{active ? 'Back to listening' : 'Identify a song'}</strong><small>{active ? `${clock(state.elapsed)} recorded · your clip is kept` : 'Hear something? Tap to listen.'}</small></span>
    </button>
    <button type="button" className="identify-entry-history" onClick={() => identifyControl.open()}>Identifications{state.freshId && <small className="identify-new">New</small>}</button>
  </div>
}

// Clean Shazam fingerprints often match from a few seconds. Wang (2003) shows
// 10–15 s clips robust in heavy noise where 5 s clips drop off: 12 s is our
// loud-room "enough" target, never an auto-send timer. The separate hard cap is 30 s.
const encouragement = (elapsed: number) => elapsed < 4 ? 'Hold it up to the music…' : elapsed < 8 ? 'Catching the beat…' : elapsed < IDENTIFY_TARGET_SECONDS ? 'Almost there, keep it steady…' : 'That should be enough to find it. Keep listening a bit longer to boost the odds.'
/** The listening orb inside the ring that fills to the 12-second target; elapsed time and encouragement underneath. */
export function CaptureProgress({ elapsed, level = 0, phase = 'recording' }: { elapsed: number; level?: number; phase?: string }) {
  const recording = phase === 'recording'
  const progress = Math.min(1, elapsed / IDENTIFY_TARGET_SECONDS)
  return <>
    <div className={'identify-orb-wrap' + (progress >= 1 ? ' reached' : '')}>
      <div className="identify-ring" {...(recording ? { role: 'progressbar', 'aria-label': 'Audio capture target', 'aria-valuemin': 0, 'aria-valuemax': IDENTIFY_TARGET_SECONDS, 'aria-valuenow': Math.min(IDENTIFY_TARGET_SECONDS, Math.floor(elapsed)) } : { 'aria-hidden': true })}>
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" /><circle className="identify-ring-value" cx="50" cy="50" r="48" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress} /></svg>
      </div>
      <div className={'identify-orb live phase-' + phase} style={{ '--level': level } as CSSProperties} aria-hidden="true"><ListenGlyph /></div>
    </div>
    <strong className="identify-timer">{clock(elapsed)} <small>elapsed</small></strong>
    <p className="identify-guidance" aria-live="polite">{phase === 'ready' ? 'Send whenever ready.' : phase === 'saving' ? 'Keeping the audio on this device first.' : recording ? encouragement(elapsed) : ' '}</p>
  </>
}
function Clip({ src }: { src: string }) { return <audio key={src} controls preload="metadata" src={src} /> }
export function IdentifyView({ notify }: { notify(message: string): void }) {
  const state = useSyncExternalStore(identifyControl.subscribe, identifyControl.snapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(''), [query, setQuery] = useState(''), [results, setResults] = useState<Candidate[]>([]), [manual, setManual] = useState(false), [title, setTitle] = useState(''), [artist, setArtist] = useState('')
  const [options, setOptions] = useState(false)
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
  const active = state.phase !== 'idle'
  const phaseText = state.phase === 'starting' ? 'Starting microphone…' : state.phase === 'saving' ? 'Saving your clip…' : state.phase === 'ready' ? 'Recording saved · ready to send' : 'Listening…'
  // The result hero opens on Send, before saving or network: saving → sending → finding (polled) → the song.
  // The confirmed song, else the hub's best lead (labelled as a possibility), else the honest no-match state.
  const saving = state.phase === 'saving'
  const sendError = local ? state.sendErrors[local.id] : ''
  const held = !!local && (local.sendRequested === false || !!sendError)
  const waiting = !saving && !local && (!detail || WAITING.includes(detail.status))
  const busy = saving || (!!local && !held) || waiting
  const lead = candidates.find(c => c.verdict === 'confirmed') || (detail?.best_title ? candidates.find(c => c.title === detail.best_title && c.verdict !== 'rejected') : undefined)
  const heroTitle = saving ? 'Saving your clip…' : local ? (held ? 'Saved on this device' : 'Sending your clip…') : waiting ? 'Finding your track…' : detail?.best_title || (candidates.length ? 'Possible matches' : detail?.status === 'error' ? 'Couldn’t finish this one' : 'No match this time')
  const heroStatus = saving ? 'Keeping the audio on this device first.' : local ? (local.sendRequested === false ? 'Not sent. You can review or send it below.' : sendError || 'Your audio is safe here while it uploads.') : waiting ? 'Identifying…' : detail ? label(detail.status) : ''
  return <>
    {state.discardNotice && createPortal(<div className="music-toast identify-notice" role={state.discardNotice.error ? 'alert' : 'status'}>
      <span>{state.discardNotice.message}</span>
      {state.discardNotice.action && <button type="button" className="identify-quiet" onClick={() => { const n = identifyControl.snapshot().discardNotice; if (!n) return; flushSync(() => { void (n.action === 'discard' ? identifyControl.discard(n.id) : identifyControl.restore(n.id)) }) }}>{state.discardNotice.action === 'undo' ? 'Undo' : 'Try again'}</button>}
      <button type="button" className="identify-quiet" aria-label="Dismiss discard message" onClick={() => identifyControl.dismissDiscardNotice()}>×</button>
    </div>, document.body)}
    {state.open && <section className="identify-view" aria-label="Song identification">
      <div className="identify-bar"><button type="button" className="identify-icon" aria-label="Back to Music" onClick={() => identifyControl.back()}><ChevronLeft /></button></div>
      <section className={'identify-stage' + (active ? ' active' : '')}>
        {active ? <div className="identify-recording">
          <p className="identify-phase" role="status">{phaseText}</p>
          <CaptureProgress elapsed={state.elapsed} level={state.level} phase={state.phase} />
          <meter className="wz-sr" min={0} max={1} value={state.level} aria-label="Microphone level" />
          <div className="identify-stage-actions">
            <button type="button" className="identify-send" disabled={!['recording', 'ready'].includes(state.phase)} onClick={() => { flushSync(() => { void identifyControl.stop() }) }}>{state.elapsed < 5 ? 'Find it now · early' : 'Find it'}</button>
            <button type="button" className="identify-quiet" disabled={state.phase === 'saving'} onClick={() => identifyControl.cancel()}>Cancel</button>
          </div>
          <p className="identify-caption">You can send early. Listening stops at {IDENTIFY_LIMIT_SECONDS} seconds and sends it for identification. Your audio is kept even when there's no match.</p>
        </div> : <>
          <p className="identify-phase">{state.needsTap ? 'Tap to start listening' : 'Tap to identify'}</p>
          <div className="identify-orb-wrap"><button type="button" className="identify-orb" aria-label="Identify song" onClick={listen}><ListenGlyph /></button></div>
          <p className="identify-caption">Hear something? Every clip is kept, matched or not.</p>
          <div className="identify-options">
            <button type="button" className="identify-option-toggle" aria-expanded={options} aria-controls="identify-options" onClick={() => setOptions(!options)}>
              <NoteGlyph /><span>{state.note ? `“${state.note}”` : 'Add a note'}{state.geoEnabled ? ' · Location on' : ''}</span>
            </button>
            {options && <div id="identify-options" className="identify-options-panel">
              <input className="wz-input" aria-label="Note for next recording" placeholder="Optional note · venue, DJ, moment" value={state.note} onChange={e => identifyControl.configure(e.target.value, state.geoEnabled)} />
              <label className="identify-geo"><input type="checkbox" checked={state.geoEnabled} onChange={e => identifyControl.configure(state.note, e.target.checked)} /> Save approximate location for the next identification</label>
            </div>}
          </div>
        </>}
      </section>
      {state.error && <p role="alert" className="identify-error">{state.error}</p>}
      {!active && <section className="identify-history" aria-labelledby="identify-history-title">
        <div className="identify-history-head"><h2 id="identify-history-title">Identifications</h2><button type="button" className="identify-icon" aria-label="Refresh identifications" onClick={() => { void identifyControl.drain() }}><RefreshGlyph /></button></div>
        {queued.map(c => <button type="button" className={'identify-hunt' + (state.freshId === c.id ? ' identify-fresh' : '')} key={c.id} onClick={() => { void identifyControl.detail(c.id) }}><span className="identify-hunt-tile waiting" aria-hidden="true"><ListenGlyph /></span><span className="identify-hunt-copy"><strong>Unknown song</strong><span>{time(c.client_ts)} · Saved on this device · {c.sendRequested === false ? 'Not sent · tap to review' : state.sendErrors[c.id] || 'waiting for connection'}</span></span><span className="identify-hunt-end">{state.freshId === c.id && <small className="identify-new">New</small>}<ChevronRight /></span></button>)}
        {state.hunts.map(c => <button type="button" className={'identify-hunt' + (state.freshId === c.id ? ' identify-fresh' : '')} key={c.id} onClick={() => { void identifyControl.detail(c.id) }}><span className={'identify-hunt-tile ' + (c.status === 'resolved' ? 'resolved' : c.status === 'has_leads' ? 'leads' : WAITING.includes(c.status) ? 'waiting' : 'quiet')} aria-hidden="true">{c.status === 'resolved' ? <CheckGlyph /> : c.status === 'has_leads' ? <NoteMark /> : <ListenGlyph />}</span><span className="identify-hunt-copy"><strong>{c.best_title || 'Unknown song'}</strong><span>{c.best_artist ? c.best_artist + ' · ' : ''}{time(c.created_at)} · {label(c.status)}</span></span><span className="identify-hunt-end">{state.freshId === c.id && <small className="identify-new">New</small>}<ChevronRight /></span></button>)}
        {!state.hunts.length && !queued.length && <p className="wz-empty">{state.loading ? 'Loading identifications…' : 'Hear something? Tap the button above. Every clip is kept.'}</p>}
        <div className="identify-footer"><button type="button" className="identify-quiet" onClick={() => { void act('retry-all', () => identifyControl.retryUnsolved()) }} disabled={!!pending}>{pending === 'retry-all' ? 'Queued…' : 'Retry all unsolved'}</button><button type="button" className="identify-quiet" onClick={() => { void act('retention', async () => { const result = await identifyJson<{ to_archive: string[]; to_delete_audio: string[] }>('retention/dry-run'); notify(`Retention dry-run only · ${result.to_archive?.length || 0} eligible for archive · no audio deleted`) }) }}>Retention dry-run</button></div>
      </section>}
    </section>}
    {state.selected && createPortal(<dialog ref={dialog} className="wz-sheet identify-sheet" aria-label="Identification details">
      <h2>Identification{detail ? ' · ' + time(detail.created_at) : ''}</h2>
      {state.error && <p role="alert">{state.error}</p>}
      <div className={'identify-result' + (busy ? ' waiting' : '')}>
        {lead?.art_url && !busy && !local ? <img className="identify-result-art" alt="" src={lead.art_url} /> : <span className={'identify-result-orb' + (busy ? ' live' : '')} aria-hidden="true">{detail?.status === 'resolved' && !local && !saving ? <CheckGlyph /> : <ListenGlyph />}</span>}
        <div className="identify-result-copy" role="status" aria-live="polite">
          <h3 className="identify-result-title">{heroTitle}</h3>
          {!busy && !local && detail?.best_artist && <p className="identify-result-artist">{detail.best_artist}</p>}
          <p className="identify-result-status">{busy && <span className="music-wheel" aria-hidden="true" />}{heroStatus}</p>
          {waiting && <p className="identify-result-hint">About 6 seconds in our last check. Noisy clips can take longer.</p>}
        </div>
        {detail?.note && <p className="identify-muted">“{detail.note}”</p>}
        {local?.sendRequested === false && <><button type="button" className="identify-send" disabled={saving} onClick={() => { void identifyControl.submit(local.id) }}>Send for identification</button>
          {state.phase === 'idle' && <button type="button" className="identify-quiet" onClick={() => { flushSync(() => { void identifyControl.discard(local.id) }) }}>Discard</button>}
        </>}
        {local && sendError && <button type="button" className="identify-send" onClick={() => { void identifyControl.drain() }}>Try again</button>}
      </div>
      {(detail || local) && <>
        {detail?.last_error && <p role="alert" className="identify-error">{detail.last_error}</p>}
        <h3>Your clip</h3><Clip src={localUrl || detail?.audio_url || ''} />
        {detail && <>
          {candidates.length > 0 && <><h3>Possible matches</h3>          {candidates.map(c => <article className={'identify-candidate ' + (c.verdict === 'rejected' ? 'identify-rejected' : '')} key={c.id}>
            <div className="identify-candidate-title">{c.art_url ? <img alt="" src={c.art_url} /> : <span className="identify-candidate-art" aria-hidden="true"><NoteMark /></span>}<div><strong>{c.title}</strong><p>{c.artist} · {c.provider}</p></div></div>
            <div className="identify-actions">
              <button type="button" className="identify-pill primary" disabled={!!pending || c.verdict === 'confirmed'} onClick={() => { void act('confirm-' + c.id, async () => { await identifyControl.verdict(c, 'confirmed'); notify('Liked · saved in Music') }) }}>{pending === 'confirm-' + c.id ? 'Saving…' : c.verdict === 'confirmed' ? '✓ Confirmed' : 'This is it'}</button>
              <button type="button" className="identify-pill" disabled={!!pending} onClick={() => { void act('play-' + c.id, () => identifyControl.play(c)) }}>{pending === 'play-' + c.id ? 'Finding full song…' : <><PlayMark />Play</>}</button>
              <button type="button" className="identify-quiet" disabled={!!pending} onClick={() => { void act('reject-' + c.id, () => identifyControl.verdict(c, 'rejected')) }}>Not it</button>
              <button type="button" className="identify-quiet" disabled={!!pending} onClick={() => { void act('download-' + c.id, async () => { await identifyJson(`candidates/${c.id}/download`, {}); notify('Downloaded to your library') }) }}>{pending === 'download-' + c.id ? 'Downloading…' : 'Download to library'}</button>
            </div>{c.compare_url && <details><summary>Compare 30-second preview</summary><Clip src={c.compare_url} /></details>}
          </article>)}</>}
          <details className="identify-more" open={!waiting && !candidates.length}><summary>Not listed? Search or add it</summary>
            <form className="identify-search" onSubmit={e => { e.preventDefault(); void doSearch(query) }}><input className="wz-input" aria-label="Search title or artist" placeholder="Search title or artist" value={query} onChange={e => { setQuery(e.target.value); queryGeneration.current++; setResults([]) }} /><button className="identify-pill" type="submit">Search</button></form>
            {results.map((c, i) => <button type="button" className="identify-hunt" key={i} disabled={!!pending} onClick={() => { void act('add-' + i, async () => { await identifyControl.add(detail.id, c); setResults([]) }) }}><span>{c.title} · {c.artist}</span><span>Add</span></button>)}
            <button type="button" className="identify-quiet" onClick={() => setManual(!manual)}>Add manually</button>
            {manual && <form className="identify-manual" onSubmit={e => { e.preventDefault(); void act('manual', async () => { await identifyControl.add(detail.id, { title, artist }); setManual(false) }) }}><input className="wz-input" required aria-label="Song title" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} /><input className="wz-input" aria-label="Artist" placeholder="Artist" value={artist} onChange={e => setArtist(e.target.value)} /><button className="identify-pill" disabled={!!pending}>Add candidate</button></form>}
          </details>
          <div className="identify-footer"><button type="button" className="identify-pill" disabled={!!pending} onClick={() => { void act('retry', () => identifyControl.retry(detail.id)) }}>{pending === 'retry' ? 'Queued…' : 'Try again'}</button>
            {detail.status === 'no_match' && !local && !busy && state.phase === 'idle' && detail.retention_state !== 'discarded' && <button type="button" className="identify-quiet" disabled={!!pending} onClick={() => { flushSync(() => { void identifyControl.discard(detail.id) }) }}>Discard</button>}
            <button type="button" className="identify-pill" disabled={!!pending} onClick={() => { if (preparedShare) { void window.WizardApp.share?.file(preparedShare, { title: 'Know this song? · Wizard Music' }).then(r => { if (r === 'unsupported') notify('Sharing unavailable. Use Download clip.'); else if (r === 'copied') notify('Copied') }); return }; void act('share', async () => { const r = await fetch(detail.export_url || detail.audio_url || ''); if (!r.ok) throw new Error('Clip unavailable'); const blob = await r.blob(); setPreparedShare(new File([blob], `hunt-${detail.id}.mp3`, { type: blob.type })); notify('Clip ready · tap Share clip') }) }}>{preparedShare ? 'Share clip' : pending === 'share' ? 'Preparing…' : 'Export clip'}</button><a className="identify-pill" href={detail.export_url || detail.audio_url} download>Download clip</a></div>
          <div className="identify-details">
            <details><summary>Capture details</summary><p className="identify-muted">SHA-256: <code style={{overflowWrap:'anywhere'}}>{detail.raw_sha256}</code></p></details>
            <details><summary>Original recording</summary><Clip src={detail.original_url || ''} /></details>
            <details><summary>Attempts ({detail.attempts?.length || 0})</summary>{detail.attempts?.map(a => <p className="identify-muted" key={a.id}>{a.provider} · {a.outcome} · {a.preprocess}{a.error ? ' · ' + a.error : ''}</p>)}</details>
          </div>
        </>}
      </>}
    </dialog>, document.body)}
  </>
}
