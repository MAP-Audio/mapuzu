// @title Haze Garden
// @by mapuzu
// @genre psychedelic hip hop
// @preset haze-garden.preset
// @cycles 16
// @tail 4
// @license CC0-1.0 (code)
//
// Both at once: PAM makes every sound and plays the tabla from a pattern of its own, and Strudel
// sends the notes and the clock, picks PAM's variation and turns the tabla player's density.
// Load haze-garden.preset in PAM and import haze-garden.midimap.json (Settings > Mappings). PAM
// needs External Clock Sync on, and Experimental Mode with FX Rack Graph, CM-FX, CMI and
// Generative Patterns. This is the song at its fullest, as a loop: songs/README.md says how it
// was built up and how it ends.

setcpm(86/4)

await pamsetup({
  channels: 'cell', poly: [5, 6, 7, 8], roots: { 5: 36 },
  names: { bd: 1, sd: 2, hh: 3, tabla: 4, bass: 5, gtr: 6, tape: 7, koto: 8 },
})

// PAM plays the tabla itself and lands its variations on its own bar line, so it needs
// Strudel's clock
$: pamclock().pam()

// one number swings the kick, the hats, the bass and the koto: 1/3 puts them on the triplet
const sw = 1/4

$: s("bd [~@3 bd] [~ bd] ~").swingBy(sw,8).pam()
$: s("~ sd ~ sd").late(.008).pam()
// PAM's side: variation 1 as programmed, 2 the trip, 3 the bloom. PAM glides between them over
// two bars
$: variation(3).pam()
$: s("hh*8").sometimesBy(.3, x => x.ply(2)).gain(perlin.range(.5,1)).swingBy(sw,8).pam()
$: chord("<Dm9!2 Bb^7 Gm9>").voicing().struct("x ~ ~ [~ x]").s("gtr").pam()
$: note("<d2!2 bb1 g1>").struct("x [~@3 x] [~ x] [~@3 x]").s("bass").swingBy(sw,8).pam()
// the tabla is PAM's own player: this only says how busy it is
$: knob("playerDensity", perlin.range(.2,.9).segment(4)).cell("tabla").pam()
$: n("0 ~ [4 3] ~ 2 ~ [~ 4] 0").off(1/8, x => x.add(n(2))).scale("d4:hirajoshi").s("koto").swingBy(sw,8).pam()
$: note("<[a4,e5]!2 [f4,d5] [g4,d5]>").s("tape").pam()

// To stop the record: mute the guitar line (_$:) and add the line below. It engages the Vinyl
// Brake on every cell.
// $: knob("vinylbrakeEngage", 1).cell("[1,2,3,4,5,6,7,8]").pam()
