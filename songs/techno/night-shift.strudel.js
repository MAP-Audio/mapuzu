// @title Night Shift
// @by mapuzu
// @genre techno
// @preset night-shift.preset
// @cycles 88
// @tail 4
// @license CC0-1.0 (code)
//
// More Strudel than PAM: every note is written here, and PAM is the sound engine.
// Load night-shift.preset in PAM, import night-shift.midimap.json (Settings > Mappings),
// point a MIDI port at PAM and play. Offline: mapuzu render night-shift.strudel.js --out <folder>

setcpm(132/4)

await pamsetup({
  channels: 'cell',
  poly: [5, 7, 8], roots: { 5: 36, 7: 48, 8: 48 },
  names: { bd: 1, cp: 2, hh: 3, oh: 4, acid: 5, perc: 6, stab: 7, pad: 8 },
})

// timeline (cycles): intro 0-8 | groove 8-24 | acid 24-40 | break 40-48 | build 48-56 | drop 56-80 | outro 80-88

// drums
const bd   = s("bd*4").velocity("1 .88 .94 .88")
const bdx  = s("bd").struct("x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ [~ x] ~").velocity(.95)
const roll = s("bd").struct("x*4 x*4 x*8 x*16").velocity(saw.range(.45, 1))
const cp   = s("~ cp").velocity("<.8 .8 .8 [.8 .5]>")
const hh   = s("hh*16").velocity("[.55 .22 .7 .22]*4")
  .knob("synth_p2", "<.2!3 [.2 .2 .2 .34]>")
const oh   = s("[~ oh]*4").velocity(.7)
const perc = s("perc").struct("~ x ~ [~ x] ~ ~ x ~ ~ [x ~] ~ x ~ ~ [~ x] ~").velocity("[.7 .5 .9]/2")
  .knob("synth_p1", "<.4 .4 .52 .34>")

// acid: one bar of eighths, turned by the cutoff and the envelope over the long arcs
const line = "<[c2 c2 c3 c2 eb2 c2 c3 g2] [c2 c2 c3 c2 eb2 c2 bb2 c3] [c2 c2 c3 c2 eb2 c2 c3 g2] [f2 f2 f3 f2 ab2 f2 eb3 f3]>"
const acid = note(line).s("acid").clip(.55)
  .velocity("[.7 .5 1 .5 .8 .5 1 .6]")
const acid16 = note(line).s("acid").ply("<1 1 2 [1 2]>").clip(.5)
  .velocity("[.75 .5 1 .5]*2")

// stabs and pad, in C minor
const stab = note("<[~ [c4,eb4,g4]] ~ [~ [c4,eb4,g4]] [~ [bb3,d4,f4]]>").s("stab").clip(.4).velocity(.8)
const stab2 = note("[~ [c4,eb4,g4]]*2 [~ [c4,eb4,g4]] <[~ [bb3,d4,f4]] [[ab3,c4,eb4] ~]>").s("stab").clip(.35).velocity(.85)
const pad  = note("<[c3,g3,eb4] [c3,g3,eb4] [ab2,eb3,c4] [bb2,f3,d4]>/2").s("pad").velocity(.6)

stack(
  //                    intro  groove  acid   break  build  drop    outro
  bd.mask(            "<1@8    1@16    1@16   0@8    0@8    1@24    1@4 0@4>"),
  bdx.mask(           "<0@8    0@16    0@16   0@8    1@6 0@2 0@24   0@8>"),
  roll.mask(          "<0@8    0@16    0@16   0@8    0@7 1  0@24    0@8>"),
  cp.mask(            "<0@8    1@16    1@16   0@8    0@8    1@24    0@8>"),
  hh.mask(            "<0@4 1@4 1@16   1@16   0@8    1@8    1@24    1@8>"),
  oh.mask(            "<0@8    0@8 1@8 1@16   0@8    0@8    1@24    0@8>"),
  perc.mask(          "<0@8    1@16    1@16   1@8    1@8    1@24    1@8>"),
  acid.mask(          "<0@8    0@16    1@16   1@8    0@8    0@24    0@8>"),
  acid16.mask(        "<0@8    0@16    0@16   0@8    1@8    1@24    0@8>"),
  stab.mask(          "<0@8    0@8 1@8 1@16   1@8    0@8    0@24    1@8>"),
  stab2.mask(         "<0@8    0@16    0@16   0@8    0@8    1@24    0@8>"),
  pad.mask(           "<1@8    0@16    0@16   1@8    1@8    0@8 1@16 1@8>"),

  // knobs: the acid filter opens through the acid section, closes for the break, and rides the drop
  knob("cmi_p1", "<.24@24 .24 .28 .32 .36 .4 .44 .48 .52 .56 .6 .64 .68 .72 .76 .8 .84 .5@8 .3 .36 .42 .48 .54 .6 .7 .8 .66@24 .4@8>").cell("acid"),
  knob("cmi_p3", "<.6@24 .6@16 .45@8 .5@8 .78@24 .6@8>").cell("acid"),
  knob("delayMix", "<0@24 12@16 40@8 10@8 18@24 0@8>").cell("acid"),
  // the pad's brightness rises and falls with the sections
  knob("cmi_p2", "<.35@8 .45@32 .7@8 .8@8 .5@24 .3@8>").cell("pad"),
).pam()
