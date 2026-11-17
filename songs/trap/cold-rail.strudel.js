// @title Cold Rail
// @by mapuzu
// @genre trap
// @preset cold-rail.preset
// @cycles 76
// @tail 5
// @license CC0-1.0 (code)
//
// Both at once: PAM plays the hats, open hat and rim from its own patterns, a different set in
// each variation, and Strudel chooses the variation, mutes and turns knobs. Kick, clap, 808 and
// the two CMI instruments are written here.

setcpm(140/4)

await pamsetup({
  channels: 'cell',
  poly: [5, 7, 8], roots: { 5: 36, 7: 60, 8: 48 },
  names: { bd: 1, cp: 2, hh: 3, oh: 4, sub: 5, rim: 6, bell: 7, pad: 8 },
})

// PAM plays its own patterns here, so it needs Strudel's clock: a standalone PAM with External
// Clock Sync on. In a DAW, take this out and follow PAM: pamsetup({ ..., follow: true })
$: pamclock().pam()

// timeline (cycles): intro 0-4 | verse 4-20 | hook 20-36 | break 36-40 | verse 40-56 | hook 56-72 | outro 72-76

// PAM's side: variation 1 is plain eighths, 2 adds rolls, 3 is the busy hook, 4 is the break
$: variation("<4@4  1@8 2@8  3@16  4@4  2@16  3@16  4@4>").pam()

// the hats drop out for the bar before each hook, and the rim rests through the intro
$: knob("mute", "<0@19 1 0@35 1 0@20>").cell("hh").pam()
$: knob("mute", "<1@4 0@72>").cell("rim").pam()

// Strudel's side
const kick = "<[x ~ ~ ~ ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~] [x ~ ~ x ~ ~ x ~ ~ ~ ~ ~ x ~ ~ ~]>"
const bd  = s("bd").struct(kick).velocity(.95)
const cp  = s("~ cp").velocity("<.9 .9 .9 [.9 .6]>")
const sub = note("<[f1 ~ ~ ~ ~ ~ f1 ~ ~ ~ ab1 ~ ~ ~ ~ ~] [f1 ~ ~ f1 ~ ~ eb1 ~ ~ ~ ~ ~ c2 ~ ~ ~] [db1 ~ ~ ~ ~ ~ db1 ~ ~ ~ f1 ~ ~ ~ ~ ~] [eb1 ~ ~ eb1 ~ ~ c1 ~ ~ ~ ~ ~ c2 ~ bb1 ~]>")
  .s("sub").clip("<5 4 5 4>").velocity(.95)
const bell = note("<[c5 ~ ~ ab4 ~ ~ f4 ~] [~ g4 ~ ~ ab4 ~ ~ ~] [c5 ~ ~ ab4 ~ ~ f4 ~] [~ eb5 ~ c5 ~ ~ ab4 g4]>")
  .s("bell").clip(1.5).velocity("[.8 .6]*4")
const bell2 = bell.transpose("<12 12 12 [12 0]>").velocity(.55).late(1/16)
const pad  = note("<[f3,ab3,c4] [f3,ab3,c4] [db3,f3,ab3] [eb3,g3,bb3]>").s("pad").velocity(.6)

$: stack(
  //             intro  verse  hook   break  verse  hook   outro
  bd.mask(     "<0@4    1@16   1@16   0@4    1@16   1@16   0@4>"),
  cp.mask(     "<0@4    1@16   1@16   0@4    1@16   1@16   0@4>"),
  sub.mask(    "<0@4    1@16   1@16   0@4    1@16   1@16   0@4>"),
  bell.mask(   "<1@4    0@8 1@8 1@16  1@4    1@16   1@16   1@4>"),
  bell2.mask(  "<0@4    0@16   1@16   0@4    0@16   1@16   0@4>"),
  pad.mask(    "<1@4    0@16   1@16   1@4    0@16   1@16   1@4>"),
  // the 808 rings longer in the hooks, and the bell's echo opens in the break and the outro
  knob("synth_p4", "<.5@20 .62@16 .5@20 .62@16 .5@4>").cell("sub"),
  knob("delayMix", "<28@36 55@4 28@32 60@4>").cell("bell"),
).pam()
