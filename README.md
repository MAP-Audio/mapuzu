# @mapaudio/mapuzu

Plays MAP Audio's instruments from Uzulangs. Today that is [PAM](https://map.audio), from two of
them: [Strudel](https://strudel.cc), where PAM is an output (`.pam()`), and
[TidalCycles](https://tidalcycles.org), where PAM is an OSC target (`mapaudio.tidal`). Patterns
play notes into PAM's cells, turn every parameter that a MIDI mapping can reach, switch
variations, mute cells and run the transport. PAM is the plugin or the standalone app, played over
MIDI, or PAM in a browser tab, played with [nothing installed](#pam-in-the-browser-no-install).
The Strudel patterns also render offline through `mapcli`, PAM's command-line engine.

In Strudel:

```js
setcpm(132/4)
$: s("1*4, ~ 2, 3*8").pam()                                     // cells 1-3 as a drum kit
$: note("c2 [eb2 g2]").cell(5).pam()                            // cell 5 by pitch
$: knob("filterCutoff", sine.range(300, 6000).slow(8).segment(16)).cell(5).pam()
$: variation("<1 1 2 3>/4").pam()                               // PAM's own variations, on the bar
```

In TidalCycles ([below](#tidalcycles)):

```haskell
setcps (132/60/4)
d1 $ pam "1*4, ~ 2, 3*8"                                        -- cells 1-3 as a drum kit
d2 $ note "c3 [ef3 g3]" # cell "5"                              -- cell 5 by pitch
d3 $ segment 16 $ knob "filterCutoff" (range 300 6000 $ slow 8 sine) # cell "5"
d4 $ variation "<1 1 2 3>/4"                                    -- PAM's own variations, on the bar
```

## Install

```sh
npm install @mapaudio/mapuzu
```

It needs Node 22 or later, and [PAM](https://map.audio) to play. It is plain ESM with JSDoc types
and runs with no build step. `npx mapuzu help` lists the commands. This page writes `mapuzu` for
`npx mapuzu`: with `npm install -g @mapaudio/mapuzu` the command is on your PATH.

To play PAM from [strudel.cc](https://strudel.cc), serve the page module from your own machine and
import it in the REPL:

```sh
mapuzu serve        # prints the two lines below
```

```js
await import('http://localhost:4747/mapuzu.mjs')   // single quotes: the REPL reads double ones as mini-notation
await pamsetup()                                   // opens the MIDI port. Pass it what your preset needs
```

A PAM that runs in a browser tab needs none of this: [PAM in the browser, no install](#pam-in-the-browser-no-install).

## Uzulangs

The Uzulangs are the family of free and open source live coding environments that have grown up
around TidalCycles: Tidal itself, Strudel, Vortex, Zwirn and others, around seventeen when the
paper below was written. No standard defines them. They are known by what they share: a pattern is
a pure function of time, time is rational and counted in cycles, rhythm has a short notation of its
own (the mini-notation), a library of functions transforms and combines patterns, and the code
shows what it is playing. *Uzu* is a Japanese word for spiral.

- Alex McLean, Felix Roos, Matthew Kaney, Martin Gius, Diego Villaseñor, Dagur Kristinn Sigurðsson
  Björnsson, Jack Armitage and Julian Rohrhuber. 2026. "Uzulangs: a Community of Musical Pattern
  Languages." *Proceedings of the International Conference on New Interfaces for Musical
  Expression* (NIME 2026, London), 70-77. <https://doi.org/10.5281/zenodo.20784054>
  ([PDF](https://nime.org/proceedings/2026/nime2026_9.pdf))
- [uzu.lurk.org](https://uzu.lurk.org) is the community's forum, the Uzu live coding pattern club.
  Its [language directory](https://uzu.lurk.org/t/uzu-language-directory/6121) lists the
  Uzulangs, with each one's host language, licence and source.

This package is not an Uzulang and adds no pattern language. It gives two of them something new to
play: the patterns are Strudel's and Tidal's own, and only the far end is new. It is also not a
project of the uzu community. The paper says of the Uzulangs that people wrote them and that they
are free software. PAM is a commercial instrument whose source is closed, and this package was
created with AI assistance ([AI disclosure](#ai-disclosure)). What is free software here is the
package (AGPL-3.0-or-later), which reaches PAM from outside: over MIDI, through the play interface
that PAM publishes for the browser, and through `mapcli`.

## Three ways to play

**More Strudel.** PAM is the sound engine and every note is written in Strudel
([songs/techno](songs/techno/night-shift.strudel.js)):

```js
await pamsetup({ channels: 'cell', poly: [5], roots: { 5: 36 }, names: { bd: 1, hh: 3, acid: 5 } })

$: s("bd*4").pam()
$: s("hh*16").velocity("[.55 .22 .7 .22]*4").knob("synth_p2", "<.2!3 [.2 .2 .2 .34]>").pam()
$: note("<[c2 c2 c3 c2 eb2 c2 c3 g2]>").s("acid").clip(.55)
  .knob("cmi_p1", saw.range(.24, .84).slow(16))
  .pam()
```

**More PAM.** The preset holds the patterns and the code only conducts. A whole song can be four
lines like these, a clock, a tempo and a `pamsetup`:

```js
$: variation("<5@4 1@8 2@4 3@8 1@8 2@4 3@8 4@8 3@16 5@4>").pam()
$: knob("mute", "<0@15 1 0@19 1 0@15 1 0@20>").cell("kick").pam()
$: knob("mute", "<0@4 1@4 0@64>").cell("snare").pam()
$: knob("cmi_p3", "<.4@12 .45 .52 .6 .68 .55@16 .45 .52 .6 .68 .55@16 .6@4 .7@12 .4@4>").cell("strings").pam()
```

**Both at once.** PAM plays some cells from its own patterns while Strudel plays the others and
switches PAM's variations under them ([songs/trap](songs/trap/cold-rail.strudel.js)):

```js
$: variation("<4@4 1@8 2@8 3@16>").pam()                        // PAM: hats, open hat, rim
$: s("bd").struct("x ~ ~ ~ ~ ~ x ~ ~ ~ x ~ ~ ~ ~ ~").pam()      // Strudel: kick
$: note("f1 ~ ~ ~ ~ ~ f1 ~ ~ ~ ab1 ~ ~ ~ ~ ~").s("sub").clip(5).pam()
```

## Vocabulary

Controls write plain keys into the hap, and `.pam()` reads them. Nothing here is specific to
Strudel's internals: a hap is a flat map of names to numbers and strings.

| In the pattern | What PAM does |
|---|---|
| `s("1")`, `s("c1")`, `s("bd")` | plays a cell: by number, by `c1`-`c8`, or by a name from `pamsetup({ names })` |
| `note("c2")`, `freq(110)` + `.cell(5)` or `.s("bass")` | plays that pitch on the cell (the cell must be poly in the preset) |
| `n("0 3 7")` + `.cell(5)` | plays that many steps above the cell's root: a slice of a slice-keymapped cell, or a key |
| `.cell(5)`, `.cell("bass")` | says which cell a note, knob or press is for. Alone it plays nothing |
| `.velocity(.8)`, `.gain(.5)` | note velocity, multiplied |
| `.clip(.5)`, `.legato(2)` | note length, as everywhere in Strudel |
| `knob(id, value)` | sets any parameter that a MIDI mapping can reach, in its own unit (below) |
| `variation("<1 2>")`, alias `vari` | switches variation 1-8. PAM makes the switch on the next bar line |
| `press("mute")` and friends | presses a button: `mute`, `solo`, `stop`, `trigger` (the hap's cell), `record`, `looperRecord`, `looperArmAll`, `looperDisarmAll`, `looperClearAll`, `looperCapture`, `looperArm:n`, `looperMute:n`, `looperSolo:n`, `looperClear:n`, `looperVariation:n`, `resample` (into the hap's cell) |
| `progNum`, `midicmd`, `ccn`/`ccv`, `nrpnn`/`nrpv`, `midichan` | plain MIDI, as `.midi()` reads them: for whatever was learned by hand in PAM |
| `.pam()`, `.pam('port name')`, `.pam({ port, latency })` | the output. `all(pam)` sends every pattern |
| `await pamsetup({...})`, `pamstatus()`, `pamhush()` | setup (waits for the MIDI port, or with `web: true` for PAM's tab), state, silence |
| `pamclock()`, `pamsetup({ follow: true })` | one timeline for both: PAM follows Strudel's MIDI clock, or Strudel follows PAM's clock (below) |
| `pamtheme()` | PAM's colours on the REPL: the editor, the page around it and what `._pianoroll()`, `._punchcard()` and `._scope()` draw with. `pamtheme(false)` goes back |

### knob

```js
knob("filterCutoff", "<300 1200 8000>").cell(3)      // a per-cell name goes to the hap's cell
knob("cell3_delayMix", 40)                           // a full id needs no cell
knob("macro_filterCutoff", saw.range(200, 12000).slow(8).segment(32))
knob("mode", "<Trigger Gate Loop>").cell(2)          // enums by label or by number
knob("mute", "<0 1>/4").cell(3)                      // mute and solo, as levels
knob("volume", -6)                                   // master volume: `volume` on a cell is the cell's fader
```

Ids are PAM's own: `mapuzu params filter` lists them with range and unit. There are 507 per cell and
492 global ones. Values are in the parameter's unit: Hz, dB, %, semitones. A drum synth's
`synth_p1`-`synth_p8` and a CMI program's `cmi_p1`-`cmi_p24` are 0..1 slots whose meaning depends
on the engine or program in the cell.

An effect's knobs do nothing until the effect is switched on in the preset, because PAM's MIDI
reaches parameters but not the on/off switches, the choice of drum-synth engine or the CMI program.

As a function, `knob` is a pattern of knob moves with the value's structure. As a method, it sets
the knob on each note of the pattern, just before the note. A continuous signal has no steps of its
own: give it some with `.segment(n)`, or put it on notes.

## PAM in the browser, no install

PAM also runs in a browser tab, and `.pam()` can play that one: no plugin, no MIDI port and no
mapping file. Say `web` in `pamsetup`, and the patterns stay as they are:

```js
await import('https://map.audio/mapuzu.mjs')         // single quotes: the REPL reads double ones as mini-notation
setcpm(132/4)
await pamsetup({ web: true, preset: 'night-shift', names: { bd: 1, hh: 3, acid: 5 } })

$: s("bd*4").pam()
$: note("<[c2 c2 c3 c2 eb2 c2 c3 g2]>").s("acid").knob("cmi_p1", saw.range(.24, .84).slow(16)).pam()
```

On strudel.cc, PAM plays in a second tab, on map.audio. The two tabs pair under a code through
map.audio, and from then on they talk straight to each other inside your computer: no note passes
through a server. There are two ways to start:

- **From PAM's page.** [map.audio/strudel](https://map.audio/strudel) opens Strudel with a line
  like `await pamsetup({ web: { room: 'k3f9...' } })` already in the code. PAM is open there and
  listens under that code, so evaluating plays it.
- **From Strudel.** `web: true` makes a code, opens PAM's page under it in a new tab, and pairs.
  Evaluate with a key press or a click, because a browser opens a tab for nothing else, and only
  for a moment after it. If the browser does not open it, the console and `pamstatus().web.link`
  give the address: open it yourself, in the same browser, and the pairing goes through.

What `pamsetup` takes for it:

- `web: true` plays the PAM of the site that `mapuzu.mjs` was imported from, and
  `web: 'https://...'` names another one. `web: { room: 'code' }` pairs with the PAM page that
  gave the code. `site` beside `room` names PAM's site when the module came from somewhere else.
- `preset` is the preset that PAM should hold, by its name in PAM's list.
  `pamstatus().web.welcome.presets` is the list.
- PAM asks in its tab whether this page may play it: choose Allow, which is also the click that
  lets PAM make sound. `await pamsetup(...)` waits for the answer. A PAM page that gave out the
  code itself does not ask the first time.
- The connection stays, and later evaluations use it. If PAM's tab is closed or loaded again, or
  you disconnect the page in PAM, the next evaluation pairs again under the same code. PAM keeps a
  Deny until its tab is closed.

PAM speaks for itself here: it tells the page which cells it has, which of them play by pitch and
from which root, every parameter with its range, and its limits. That is PAM's play interface, which
PAM publishes for any program to use. Against MIDI, these things change:

| | Over MIDI | In the browser |
|---|---|---|
| `knob` | one of 128 positions of the range | the exact value |
| `knob("mute", 1)`, `knob("solo", 1)` | a toggle, with the output keeping count | a level: it is set to what you say. A variation switch puts PAM's mutes back to what the variation stores, so the output sends each level you asked for again with every switch, and PAM lands it with the switch |
| a note's length and velocity | 7-bit velocity, and a note-off 10 ms early so that a repeat retriggers | the exact velocity and length. PAM makes the release |
| `n` | steps above the root that `roots` gives | steps above the root that PAM says the cell has |
| `channels`, `notes`, `poly`, `roots` in `pamsetup` | describe the preset to the output | not needed. `poly` and `roots` are compared with what PAM has, and a difference is reported |
| `variation` | sent 200 ms early, and PAM switches on its bar line | sent about a second and a half early, and PAM switches on its bar line while its transport runs, and at once while it is stopped |
| `pamclock()` | MIDI clock, which a standalone PAM follows | starts PAM's transport where the pattern is and at the pattern's tempo, and tells PAM when the tempo changes. Stopping the REPL stops it |
| `press`, `progNum`, `ccn`/`ccv`, `nrpnn`/`nrpv` | sent | not sent: the interface has no event for them, and the output says so once. Nothing is sent in their place |
| `follow: true` | Strudel follows PAM's clock | refused: PAM in the browser does not send its clock to the page that plays it |

`pamstatus().web` shows the connection: its `state`, how PAM is reached (`via`), the `room` code,
what PAM said it has (`welcome`), and what PAM accepted and refused, counted by PAM's own codes
(`cell_not_armed`, `unknown_parameter`, `out_of_range`, `too_late` and the rest). PAM refuses what
it will not play and says why. The output reports each kind once and plays on.

Stopping the REPL releases PAM's notes and drops the knob moves and switches that were waiting.
Notes that Strudel had already sent ahead, a tenth to a third of a second of them, still play: PAM
cannot take back a note it has been handed.

**Timing.** Every event carries the time at which it should be heard, on the clock that the tabs
of one browser share, and PAM puts a note on the audio sample of that time. For that PAM needs each
event a little ahead: `pamstatus().web.leadMs`, some tens of milliseconds on a computer's own
output and a lot more through wireless headphones. PAM refuses an event that comes later than
that, and does not play it late. Strudel's scheduler sends a tenth to a third of a second ahead
(`aheadMs` is the least it has given), which is normally plenty. When it is not, the output moves
everything it sends later by what is missing, in steps of 10 ms, and says so (`shiftMs`). PAM gives
its lead again in its answer to every message, and the shift follows it: up from the next message
when wireless headphones are connected, and down again when they are taken off. A change of a few
milliseconds moves nothing. PAM's transport, when `pamclock()` runs it, is moved with the shift.
The shift is kept when you evaluate while Strudel plays, and starts from nothing each time Strudel
starts. `latency` in `pamsetup` moves it by hand. The two pages count the shared clock from when
each was loaded, and they can disagree, by hours if the computer slept in between. The output measures the
difference at every `pamsetup`, and again if PAM calls events far from their time, and sends every
time as PAM reads it (`clockMs`). It also sees how long its messages take to reach PAM
(`transitMs`) and allows for that.

A variation switch needs more notice than a note: PAM takes about 400 ms to get a variation ready,
and a switch that comes with less lands on the bar line after. So the output reads the switches
out of the patterns about 1.2 s ahead of Strudel's scheduler and sends each one then, with the
mutes and solos that the patterns hold, as they will be at the switch. Nothing else is sent early
and nothing is moved for it. It reads ahead only once a pattern has asked for a variation. A switch
that PAM has been sent cannot be taken back: evaluate code that asks for another variation at that
moment, and that one is sent at once and PAM takes it if it still has the time. Evaluate code that
asks for none there, and the switch still lands, and the output says so. Nor is a switch sent a
second time, since PAM would then switch twice, the second time a bar late. So when you evaluate
code that changes a mute or a solo under a switch that has gone, the new level is sent at its own
time and may not hold until the next switch, and after a change of tempo a switch that has gone
keeps the time that the old tempo gave it. The output says so in both cases.

**A constant in Strudel's audio.** Every time that goes to PAM is read from the clock of Strudel's
audio. When every pattern goes to `.pam()`, Strudel itself is silent, and Chrome takes audio that
has been silent for thirty seconds off the audio device and runs it from a timer. Its clock then
steps by a few milliseconds and wanders, and the notes go with it. So a page that sends to PAM
keeps a constant in Strudel's audio, a millionth of full scale, 120 dB down. It cannot be heard,
and it keeps Strudel on the audio device, whose clock is the one PAM counts its bars on.

**Keep Strudel's tab in view.** A browser slows the timers of a tab that is hidden, and Strudel's
scheduler runs on one. PAM's tab can be the one behind: PAM schedules by its audio clock. To watch
both, put PAM in a window of its own.

**Where it works.** Both tabs are in one browser on one computer. Pairing asks PAM's site, so it
needs the network for that moment. After it the two tabs talk over the computer's own network,
through a WebRTC data channel with no relay. On a Mac the browser needs Local Network access for
it (System Settings > Privacy & Security > Local Network). A firewall, a VPN, a privacy extension
or a browser setting that blocks local WebRTC also stops that connection. `pamsetup` gives it 15
seconds and then says so.

A browser keeps strudel.cc apart from tabs of other sites, which is why the tabs pair under a
code. A page that is not kept apart needs no code: there `web: true` opens PAM's tab and the two
talk by `postMessage`. To know which kind of page it is on, `web: true` asks once for the page's
own address and reads the `Cross-Origin-Opener-Policy` that the page was served with, waiting for
the answer for under a second. Where it cannot tell, it pairs under a code, which works from every
page. Nothing else asks for anything: loading the module, playing over MIDI and `web: { room }`
make no request of their own.

## Live setup

This is the setup for a PAM on your machine, the plugin or the standalone app, played over MIDI.

1. Give PAM a MIDI port: a virtual one (IAC on macOS, loopMIDI on Windows, `snd-virmidi` on Linux)
   that the browser sends to and PAM listens on. PAM standalone picks its input in Settings, and PAM
   in a DAW gets it from a MIDI track.
2. Put the package in pattern scope. On strudel.cc, or any page that already runs Strudel: run
   `mapuzu serve` and `await import('http://localhost:4747/mapuzu.mjs')` at the top of the code.
   That module binds to the page's own Strudel. In a page you build yourself:
   `evalScope(import('@mapaudio/mapuzu'))`. The four `@strudel/*` packages (`core`, `mini`, `tonal`,
   `transpiler`) are peer dependencies, so the package uses your project's Strudel and there is
   one copy of it. npm 7 and later and pnpm 8 and later install them with the package. With Yarn,
   add the four yourself. That main entry is for browsers and bundlers. In plain Node it does not
   load yet, because the published `@strudel/core` 1.2.6 imports `@kabelsalat/web`, whose entry
   for Node is a browser build with no exports. Strudel has fixed this in its repository
   ([#1930](https://codeberg.org/uzu/strudel/issues/1930),
   [#1932](https://codeberg.org/uzu/strudel/pulls/1932)), and the fix comes with the next
   `@strudel/core` release. Until then, in Node use the `mapuzu` command, or
   `@mapaudio/mapuzu/node`, `/pam` and `/tidal`, which do load.
3. `await pamsetup({...})` before the patterns, once: each call is the whole description, and what
   it leaves out goes back to PAM as installed. It opens the MIDI port (the browser asks once), so
   the first note has somewhere to go.
4. For `knob` and for `mute`/`solo`/`stop`/`trigger`/`record`, import mapuzu's mapping file once:
   `mapuzu midimap song.strudel.js --out song.midimap.json` (only what the song uses) or
   `mapuzu midimap --all`, then PAM's Settings > Mappings > Import. PAM's import replaces its list:
   `--merge exported.json` keeps what you had.

PAM answers these with no setup at all, because it listens for them out of the box: notes (each
cell on its own note, 48-55, channel 1), `variation` (CC 16), `progNum` (preset by index), the
looper presses (CC 17, 18), `resample` (CC 19), and `pamclock()` for a standalone PAM that follows
external clock. Everything else goes through mapuzu's map: one NRPN number per parameter and action,
on channel 16 by default.

```js
await pamsetup({
  port: 'IAC Driver Bus 1',     // MIDI output, by (part of) its name. The default is the first one
  channels: 'cell',             // cell N on channel N. The default is every cell on channel 1
  poly: [5, 8],                 // cells that are poly (or slice-keymapped) in the preset
  roots: { 5: 36 },             // their root notes. The default is 48
  names: { bd: 1, sd: 2, hh: 3, bass: 5 },
  latency: 0.02,                // seconds, to line PAM up with other outputs
  cc: 'automap',                // or { macro_filterCutoff: 6 }: knobs that you mapped to a plain CC yourself
  muted: [3],                   // cells muted in PAM right now, after muting by hand (see below)
})
```

PAM's MIDI can toggle a mute or a solo but cannot set it, so `knob("mute", 1)` works by keeping
count: the output starts from "nothing muted" and sends a toggle only when the level it is asked
for differs from what it last left. Re-evaluating the code and stopping the REPL keep the count. If
you mute in PAM by hand, say so with `muted` / `soloed`.

A variation switch brings back everything that the variation stores, its mutes and knob values too.
`.pam()` sends the switch first and assumes that PAM holds no mutes after it. A mute or a knob that
the pattern sets for the same bar is sent after the switch, and one that the pattern has only been
holding comes back at its next event. The count cannot know about a variation that was saved with a
cell muted.

A preset that plays more than one cell by pitch needs those cells on channels of their own, since a
poly cell answers every note on its channel. `mapuzu from-pam preset` prints the `pamsetup()` that a
preset needs. Some hosts send every MIDI channel to a plugin as channel 1 (Ableton Live does):
there, keep to one cell by pitch, or play PAM standalone.

### One timeline

A pattern that only plays notes into PAM needs no shared clock. One that plays beside PAM's own
patterns, or switches variations on PAM's bar line, does. There are two ways to share one, and
they exclude each other:

- **PAM follows Strudel.** `$: pamclock().pam()` sends MIDI clock, with Start at cycle 0 and, when
  added while already playing, a song position and Continue on the next sixteenth. A standalone PAM
  with External Clock Sync on follows it. A PAM in a DAW follows the DAW and ignores it.
- **Strudel follows PAM.** `follow: true` in `pamsetup` reads PAM's clock output and plays every
  `.pam()` pattern on PAM's timeline: cycle 12 of the pattern in PAM's bar 12, at PAM's tempo,
  through a seek, a loop or a tempo change, in a DAW too. Strudel's scheduler cannot seek, so the
  pattern is read from PAM's position and the scheduler's tempo is trimmed to hold it there.
  Other outputs in the same REPL keep the scheduler's own position. While following, PAM sets the
  tempo in place of `setcpm`. `pamstatus().clock` shows the error in milliseconds. What a pattern
  sent before PAM jumped is not sent again: after a seek, a variation or a knob held since earlier
  comes back at the pattern's next event, and the events of the first scheduler tick after a jump
  are left out.

`mapuzu fake-clock --bpm 140` is a stand-in for PAM's clock, to try following with no PAM running:
put `follow: 'http://127.0.0.1:9836/clock'` in `pamsetup`, then move it with the `curl` lines that
it prints. Against it, on strudel.cc, notes land within a millisecond of its beat.

### Timing

Each message is sent with a Web MIDI timestamp for the hap's onset, so jitter is the MIDI port's,
not the browser's. The timestamps are read from the clock of Strudel's audio, which the page keeps
on the audio device with a constant that cannot be heard (see
[A constant in Strudel's audio](#pam-in-the-browser-no-install)). Three things are not sample-accurate, all on PAM's side: a mapped parameter is
applied on a timer tick, a variation lands on a bar line, and mute and solo go through PAM's
editor. A variation switch is sent 200 ms early so that it arrives before the bar line it is meant
for.

Mapped values are 7-bit. A knob lands on one of 128 positions of its range, on the parameter's own
curve: `cell1_filterCutoff` at 1000 Hz lands on 1015 Hz. The offline render uses the exact values.

## TidalCycles

`mapaudio.tidal` makes PAM an OSC target in TidalCycles, with the vocabulary above in Tidal's own
form. Tidal sends each event as one OSC message, stamped with its time. `mapuzu tidal` receives them
and sends PAM the MIDI that `.pam()` would send, through the same encoder (`src/pam`).

1. Give PAM a MIDI port, load the preset and import the mapping file, as in [Live setup](#live-setup).
2. Run `mapuzu tidal` and open the page it prints (`http://localhost:4748/`). Leave it open in a
   window of its own: that page holds the MIDI port.
3. In `BootTidal.hs`, load `mapaudio.tidal` before the stream starts and give the stream
   `pamOscMap`. The line to replace depends on the Tidal version.

   Tidal 1.10, in place of `tidalInst <- mkTidal`:

   ```haskell
   :script /path/to/mapaudio.tidal
   tidalInst <- mkTidalWith (mkOscMap ++ [pamOscMap]) defaultConfig
   ```

   Tidal 1.9, in place of `tidal <- startTidal ...`. A 1.10 boot file in the old style
   (`BootTidal-oldstyle.hs`) has that line too:

   ```haskell
   :script /path/to/mapaudio.tidal
   tidal <- startStream (defaultConfig {cVerbose = True, cFrameTimespan = 1/20}) [(superdirtTarget {oLatency = 0.05, oAddress = "127.0.0.1", oPort = 57120}, [superdirtShape]), pamOscMap]
   ```

   `mapuzu tidal` prints both pairs of lines with the real path. A boot that keeps its targets in
   a list (`oscMap`) takes `pamOscMap` as one more entry.
4. Describe the PAM being played, once: `once $ pamsetup "channels=cell poly=5 roots=5:36 names=bd:1,acid:5"`.

```haskell
d1 $ pam "bd*4" # velocity "1 0.8"
d2 $ note "c3 [ef3 g3]" # pam "acid" # legato 0.55 # knob "cmi_p1" (range 0.24 0.84 $ slow 16 saw)
d3 $ variation "<1 1 2 3>/4"
d4 $ knob "mute" "<0 1>/4" # cell "3"
d5 $ pamclock
```

| Strudel | TidalCycles | |
|---|---|---|
| `s("bd")`, `s("1")` | `pam "bd"`, `pam "1"` | plays a cell. Not `s`: an event with an `s` is SuperDirt's |
| `note("c2")`, `n("0 3")`, `freq(110)` | `note "c3"`, `n "0 3"`, `freq 110`, `midinote 36`, `up 3` | Tidal's `c5` is middle C, which Strudel calls `c4`: a note name is one octave higher in Tidal |
| `.cell(5)`, `.cell("bass")` | `# cell "5"`, `# cell "bass"` | in quotes: it takes names as well as numbers |
| `.velocity(.8)`, `.gain(.5)` | `# velocity 0.8`, `# gain 0.5` | |
| `.clip(.5)` | `# legato 0.5`, or `# sustain` in seconds | |
| `knob("filterCutoff", 800)` | `knob "filterCutoff" 800`, or `pamFilterCutoff 800` | every parameter has a word: `pam` and its id with a capital. A parameter that takes names: `knobS "mode" "Gate"`, `pamMode "Gate"` |
| `knob("mute", 1)`, `knob("solo", 1)` | `knob "mute" 1`, `pamMute 1`, `pamSolo 1` | |
| `variation("<1 2>")` | `variation "<1 2>"`, `vari` | |
| `press("looperMute:3")` | `pampress "looperMute:3"` | Tidal has a `press` of its own |
| `progNum`, `midicmd`, `ccn`/`ccv`, `nrpnn`/`nrpv`, `midichan` | the same, with `# pamto` | in SuperDirt's units: `ccv` 0-127, `nrpnv` 0-16383, `midichan` from 0 |
| `await pamsetup({...})` | `once $ pamsetup "..."` | below |
| `pamclock()` | `d1 $ pamclock`, `pamclockOf 3` | Start at cycle 0, so `resetCycles` first |
| `pamhush()` | `once pamstop` | all notes off and MIDI stop. A clock that goes quiet stops PAM by itself |
| `.pam({ latency })` | `# nudge 0.02` | Tidal moves the event before it is sent |
| `pamstatus()` | the page, and `curl localhost:4748/status` | |

`pamsetup` takes the keys of Strudel's, as text:

```
channels=cell            or channels=3, or channels=1,1,1,1,5,6,7,8
poly=5,7,8               roots=5:36,7:60          notes=1:36
names=bd:1,cp:2,acid:5   port=IAC Driver Bus 1    latency=0.02
control=16               cc=automap               muted=3   soloed=
```

**How it gets there.** PAM has no OSC input, and Node has no MIDI without a native module. So
`mapuzu tidal` keeps the MIDI port where `.pam()` keeps it, in a browser: the page it serves sends
each message through Web MIDI with a timestamp. Tidal sends its events 300 ms ahead (`oLatency`),
each in a bundle that says when it is due. The receiver puts a frame's events in order, with a
variation switch first, and the page sends each message at its time. The bundle's time is on the
system clock and Web MIDI's is on the page's own, which drifts from it by milliseconds an hour, so
the page measures the difference again every ten seconds. Tidal, `mapuzu tidal` and the page run on
one machine: the receiver listens on `127.0.0.1` only. A program with a MIDI output of its own can
use the receiver without the page: `tidal({ send })` in `@mapaudio/mapuzu/node`, or
`createTidalReceiver({ send })` in `@mapaudio/mapuzu/tidal`.

**What Tidal does not have here.**

- Following PAM's clock (`follow: true`). Tidal can be the clock for a standalone PAM
  (`pamclock`). Inside a DAW, PAM follows the DAW and ignores MIDI clock.
- Offline rendering. `mapuzu render` evaluates Strudel code, and nothing here evaluates Haskell.
- A port per pattern. One `mapuzu tidal` plays one MIDI port. A second PAM needs a second one
  (`mapuzu tidal --port 4749`) and a second target (`pamTarget {oPort = 4749}`).
- Words for a hosted plug-in's parameters: `knob "hosted_p3_12" 0.5` reaches them by id.
- `pamtheme()`, which is for Strudel's editor.

`mapaudio.tidal` is generated: `mapuzu tidal --boot --out mapaudio.tidal` writes it from the same
parameter table as everything else, and a test fails when the two disagree.

## Offline

```sh
mapuzu render songs/techno/night-shift.strudel.js --out renders/techno
# -> night-shift.wav, night-shift.mp3, night-shift.frozen.preset, night-shift.render.json
```

`render` evaluates the Strudel file as the REPL would, takes what it sends to `.pam()` for
`// @cycles N` cycles, freezes that into the preset named by `// @preset`, and renders with mapcli.
mapcli takes no MIDI, so freezing is the way in: the pattern becomes PAM's own sequencer state.

| In the pattern | Frozen as |
|---|---|
| notes | the cell's note lane, with exact times (triplets, swing and `nudge` are kept) |
| a cell's knobs that change | its pattern lanes: each step locks the parameter until the next. A cell has four |
| a knob set once at the start | a plain value |
| `knob("mute")`, `knob("solo")`, `press("mute")` | a lock of the cell's fader at its bottom |
| `variation` | PAM's song: one step per stretch, switching on the bar, patterns' phase kept |
| a global or macro knob that changes; `pitchShift`, `slice`, `stretch`; a fifth lane | listed as not frozen: PAM has no lane for it |
| `press` of other actions, `progNum`, plain `ccn`/`nrpnn` | listed as not frozen: live only |

The frozen preset plays the song in PAM without Strudel. Rendering needs a PAM licence or trial on
the machine (`mapcli` exits 3 without one). `mapuzu freeze song.strudel.js` only reports, and needs
neither. The longest stretch is 255 bars of 4/4.

`mapuzu` finds mapcli as `--mapcli <path>`, then `$MAPCLI`, then `mapcli` on the PATH. A kit's CMI
and CM-FX programs are placed with mapcli's `song make`.

### Kits

A kit is a short JSON file that says how a preset differs from PAM's Init, and `mapuzu kit` builds
the preset from it.

```json
{
  "name": "Night Shift", "tempo": 132,
  "programs": { "cmi": { "5": "acid_bass" } },
  "channels": "cell", "pitched": [5],
  "state": { "cell1_synthEngine": "Kick", "cell1_volume": -1, "cell5_delayEnabled": 1 },
  "patterns": { "1": "x*4", "5": { "mini": "<c2 [eb2 g2]>", "bars": 2 } },
  "variations": { "2": { "patterns": { "1": "x ~ ~ x ~ ~ x ~" } } }
}
```

`pitched` cells become poly with their root where note N sounds note N (a CMI program's base note,
read back from the preset). `patterns` are PAM's own, written in mini-notation. `samples` names
files by their path inside a sample library (`--library`), and the preset keeps them relative to it.

### Mini-notation and PAM patterns, both ways

```sh
mapuzu to-pam "x ~ [~ x] ~ x ~ ~ x" --cell 1 --bars 1                   # prints the state delta
mapuzu to-pam "<c2 [eb2 g2]>" --cell 5 --bars 2 --preset in.preset --out out.preset [--slot 3]
mapuzu to-pam --code groove.strudel.js --bars 4 --preset in.preset --out out.preset
mapuzu from-pam songs/trap/cold-rail.preset --variation 3               # prints Strudel code
```

`to-pam` samples the pattern for `--bars` bars and writes it as a note lane that loops there. Note
names are pitches, `x`/`1`/`0`/`~` a rhythm, other numbers steps above the root (`--as` overrides).
`from-pam` finds the coarsest grid that each lane sits on and writes it per beat for drums, per bar
with held lengths and chords for pitched cells, with the `pamsetup()` the preset needs. It says what
it left out: chance, notes that a mono cell never plays, lengths that sit on no grid.

## Songs

[songs/](songs/README.md) has three:

- **Night Shift**, techno at 132 BPM. Strudel plays every note, and PAM is the sound engine.
- **Cold Rail**, trap at 140 BPM. PAM plays the hats, open hat and rim from its own patterns in
  four variations. Strudel plays the rest, switches the variations and mutes cells.
- **Haze Garden**, psychedelic hip hop at 86 BPM. PAM makes every sound and plays the tabla from a
  pattern of its own. Strudel sends the notes, switches PAM's variations and stops the record with
  the Vinyl Brake on every cell. PAM needs External Clock Sync on, and Experimental Mode with FX
  Rack Graph, CM-FX, CMI and Generative Patterns.

Each is a Strudel file, a TidalCycles file, the preset that PAM loads, and the mapping file for
playing it live. Night Shift and Cold Rail also have the kit that their preset is built from.

## Layout

| Path | Holds |
|---|---|
| `index.mjs`, `mapuzu.mjs`, `src/strudel/` | the Strudel package: controls and the `.pam()` output. `index.mjs` is the npm entry, and `mapuzu.mjs` is the one that a page already running Strudel imports by URL |
| `dist/mapuzu.mjs` (`@mapaudio/mapuzu/browser`) | in the npm package only: `mapuzu.mjs` and everything it imports as one file with no Strudel in it, for a website to serve. `npm run build:browser` writes it, and `npm pack` and `npm publish` run that first |
| `src/pam/` (`@mapaudio/mapuzu/pam`) | the engine side, with no pattern language in it: the parameter table (generated from PAM's manifest), the MIDI map, value map → events → MIDI bytes, the sending side of PAM's play interface for the browser, the freezer, and the arithmetic of following PAM's clock |
| `src/node/` (`@mapaudio/mapuzu/node`), `bin/mapuzu.mjs` | Strudel outside the browser, presets, mapcli, render, kits, conversion, `mapuzu serve` and the fake clock |
| `mapaudio.tidal`, `src/tidal/` (`@mapaudio/mapuzu/tidal`) | the TidalCycles side: the boot script that defines PAM as an OSC target, the code that writes it, an OSC reader, the receiver that turns Tidal's events into MIDI, and the page's MIDI port. `mapuzu tidal` (`src/node/tidal.mjs`) runs them |
| `songs/` | the three songs, in Strudel and in TidalCycles |

Each Uzulang has a binding, and only a binding: its controls write the same flat keys, and
`src/pam` does the rest. Strudel's is `src/strudel/`. TidalCycles' is `mapaudio.tidal`, whose words
put those keys in an OSC message, and `src/tidal/`, which reads them.

## Help and requests

For a problem or a feature request, come to MAP Audio's Discord: <https://discord.gg/nWh5XDNW6c>.
Issues and pull requests are closed on the repository for now. Forks are welcome under the licence
(AGPL-3.0-or-later).

## Development

```sh
npm install
npm test
node bin/mapuzu.mjs tidal --boot --out mapaudio.tidal        # after the parameter table changes
npm run build:browser                                        # dist/mapuzu.mjs, the page module as one file
node scripts/gen-pam-params.mjs /path/to/pam/manifest.json   # the parameter table, from PAM's manifest (not public)
```

## Licence

AGPL-3.0-or-later. The full text is in [LICENSE](LICENSE).

## AI disclosure

This package was created with AI assistance.

Strudel is made by the uzu community, and TidalCycles is developed there too. Strudel's
[policy](https://codeberg.org/uzu/strudel/src/branch/main/POLICY.md) declines LLM-generated
contributions, and asks that people in the community not have to deal with LLM-generated code or
text. We respect that. Nothing from this package is offered to Strudel, to TidalCycles or to any
other uzu project, or posted in the community's spaces. Report problems with it to MAP Audio
([Help and requests](#help-and-requests)), not to Strudel or TidalCycles.
