// Reuse Identify's real-shell harness, fixture proxy, screenshots and disposal.
import assert from 'node:assert/strict'
import path from 'node:path'
export async function checkPlaylists({ page, frame, shell, skin, out, settle, APP }) {
  const URL='https://www.youtube.com/watch?v=9TbASs-ZjHA'
  const TITLE='Hypnotic Progressive House & Melodic Techno 2026 | XAVRINOX - Ethereal Mix I'
  const section=frame.getByRole('region',{name:'Playlists',exact:true})
  await section.waitFor()
  await section.getByRole('button',{name:'Add link'}).click()
  await frame.getByRole('dialog',{name:'Add playlist'}).waitFor()
  const before=await frame.locator('dialog').evaluate(d=>getComputedStyle(d).color)
  await page.evaluate(s=>window.WosSkin.set(s),skin==='nebula'?'grove':'nebula')
  await frame.waitForFunction(c=>getComputedStyle(document.querySelector('dialog')).color!==c,before)
  await page.evaluate(s=>window.WosSkin.set(s),skin)
  await frame.waitForFunction(c=>getComputedStyle(document.querySelector('dialog')).color===c,before)
  await settle(frame,'dialog[open]')
  const sheetImage=path.join(out,`${shell}-${skin}-playlist-add.png`)
  await page.screenshot({path:sheetImage})
  assert.equal(await frame.evaluate(()=>window.__wizardCloseOverlay()),true)
  await frame.locator('dialog').waitFor({state:'detached'})
  await section.getByRole('button',{name:'Add link'}).click()
  await frame.getByRole('dialog',{name:'Add playlist'}).waitFor()
  const box=await (await frame.frameElement()).boundingBox()
  await page.mouse.click(box.x+3,box.y+3)
  await frame.locator('dialog').waitFor({state:'detached'})
  await section.getByRole('button',{name:'Add link'}).click()
  await frame.getByRole('textbox',{name:'YouTube link'}).fill(URL)
  await frame.getByRole('textbox',{name:'Name (optional)'}).fill(TITLE)
  // Hold the actual production fetch dependency; Save must close and acknowledge before it resolves.
  await frame.evaluate(()=>{
    const original=window.fetch;window.__qaPlaylistPosts=0
    window.fetch=async (...a)=>{if(String(a[0]).endsWith('/api/playlists')&&a[1]?.method==='POST'){window.__qaPlaylistPosts++;await new Promise(r=>window.__qaReleasePlaylist=r)}return original(...a)}
  })
  const immediate=await frame.getByRole('button',{name:'Save playlist',exact:true}).evaluate(async b=>{const t=performance.now();b.click();const closed=!document.querySelector('dialog[open]');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {closed,pending:!!document.querySelector('.music-playlist-pending'),ms:performance.now()-t}})
  assert.ok(immediate.closed&&immediate.pending,JSON.stringify(immediate))
  await frame.evaluate(()=>window.__qaReleasePlaylist())
  const link=section.getByRole('link',{name:'Open on YouTube: '+TITLE,exact:true})
  await link.waitFor()
  await section.locator('.music-playlist-pending').waitFor({state:'detached'})
  assert.equal(await link.getAttribute('href'),URL)
  assert.equal(await link.count(),1)
  assert.equal(await frame.evaluate(()=>window.__qaPlaylistPosts),1)
  // Same resource has one stable identity, despite another exact URL being supplied later.
  const first=await (await fetch(APP+'/wizard-music/api/playlists')).json()
  const duplicate=await (await fetch(APP+'/wizard-music/api/playlists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://youtu.be/9TbASs-ZjHA?t=25'})})).json()
  assert.equal(duplicate.id,first.playlists[0].id);assert.equal(duplicate.url,URL);assert.equal(duplicate.title,TITLE)
  await frame.goto(new URL('/wizard-music/',page.url()).href)
  await frame.getByRole('link',{name:'Open on YouTube: '+TITLE,exact:true}).waitFor()
  await frame.locator('.music-playlists').scrollIntoViewIfNeeded()
  await settle(frame,'.music-playlists')
  const listImage=path.join(out,`${shell}-${skin}-playlists.png`)
  await page.screenshot({path:listImage})
  const collapsed=frame.getByRole('button',{name:/^Playlists/})
  await collapsed.click();assert.equal(await collapsed.getAttribute('aria-expanded'),'false')
  await collapsed.click();assert.equal(await frame.getByRole('link',{name:'Open on YouTube: '+TITLE,exact:true}).count(),1)
  assert.equal(await frame.locator('audio[autoplay]').count(),0)
  await frame.getByRole('button',{name:'Play '+TITLE+' in Music',exact:true}).click()
  await frame.getByText(/Online playback is not connected/).waitFor()
  assert.equal(await frame.getByRole('link',{name:'Open on YouTube: '+TITLE,exact:true}).getAttribute('href'),URL)
  return {shell,skin,immediate,url:URL,id:duplicate.id,reload:true,deduped:true,back_and_outside:true,live_skin:true,no_autoplay_on_save:true,offline_playback_fallback:true,screenshots:[sheetImage,listImage]}
}
