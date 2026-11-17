# Songs

Three songs. Each shares the work between Strudel and PAM in its own way. PAM makes every sound
from its drum synths and CMI instruments: no song needs a sample. A song's folder holds:

- `<name>.strudel.js`: the song, for the REPL and for `mapuzu render`
- `<name>.preset`: the preset that PAM loads
- `<name>.midimap.json`: the mapping file that PAM imports (Settings > Mappings > Import) to play it live
- `<name>.kit.json`: what its preset is made of, readable and editable. `mapuzu kit` builds the
  preset from it. Haze Garden has none: its preset was made in PAM
- `<name>.tidal`: the song for TidalCycles, with `mapaudio.tidal` loaded and `mapuzu tidal`
  running

| Song | Who plays what | Sounds |
|---|---|---|
| [techno/night-shift](techno/night-shift.strudel.js), 132 BPM, 88 bars | Strudel plays every note, and the preset is only sounds | drum synths (Kick, Clap, HiHat, Conga) and CMI (Acid Bass, Synth Pluck, Soft Pad) |
| [trap/cold-rail](trap/cold-rail.strudel.js), 140 BPM, 76 bars | PAM plays hats, open hat and rim from its own patterns in four variations. Strudel plays kick, clap, 808 and melody, switches variations and mutes cells | drum synths (Kick, Clap, HiHat, 808, Rim) and CMI (FM Bell, Glass Pad) |
| [hiphop/haze-garden](hiphop/haze-garden.strudel.js), 86 BPM, a loop of 16 bars | PAM makes every sound and plays the tabla from a player of its own. Strudel plays the other seven cells, picks PAM's variation and turns the tabla player's density | CMI (Fold Drum, Snare, Hi-Hat, Tabla, Soul Bass, Jazz Guitar, Tape Pad, Koto) with CM-FX on six cells |

## Haze Garden

Psychedelic hip hop at 86 BPM. PAM makes every sound, and plays the tabla from a pattern of its
own. Strudel sends the notes, switches PAM's variations, and stops the record with the Vinyl Brake
on every cell.

The file is the song at its fullest, as a loop. It is built up a line at a time: kick, snare, hats,
the swing, guitar chords, bass, the tabla player's density, then the koto and the pad. Change the
variation line to `variation(2)` for the break and back to `variation(3)` for the drop, two bars
ahead of where it should land. To end, mute the guitar line and add the last line of the file,
which engages the Vinyl Brake.

PAM needs these switched on:

- External Clock Sync, with the MIDI port as PAM's input. The tabla player and the variation
  changes run on Strudel's clock.
- MIDI variation switching with Bar Sync on and an interval of 4 bars, and a variation morph of 2
  bars in Param mode.
- Experimental Mode, with FX Rack Graph, CM-FX, CMI and Generative Patterns.
- The nine mappings in `haze-garden.midimap.json`: the tabla player's density, and Vinyl Brake
  Engage on each of the eight cells.

`mapuzu freeze` takes the loop as it is: it writes Strudel's notes and the density knob into the
preset's lanes, and leaves the tabla player as the preset has it.
`mapuzu from-pam` shows nothing of the player: it reads note lanes, and the preset has none.

## Render

One command per song, to WAV and MP3. It needs `mapcli` and a PAM licence on the machine.

```sh
export MAPCLI=/path/to/mapcli
node bin/mapuzu.mjs render songs/techno/night-shift.strudel.js --out /somewhere/techno
node bin/mapuzu.mjs render songs/trap/cold-rail.strudel.js --out /somewhere/trap
```

Beside the audio it leaves `<name>.frozen.preset`, which plays the whole song in PAM with no
Strudel, and `<name>.render.json`, the record of what was frozen and how.

## Rebuild a preset

```sh
node bin/mapuzu.mjs kit songs/techno/night-shift.kit.json --out songs/techno/night-shift.preset --force
node bin/mapuzu.mjs kit songs/trap/cold-rail.kit.json --out songs/trap/cold-rail.preset --force
node bin/mapuzu.mjs midimap songs/techno/night-shift.strudel.js --out songs/techno/night-shift.midimap.json --force
```

The CMI programs are placed with mapcli's `song make`. Haze Garden has no kit to rebuild from.

## Play live

Load the preset in PAM, import the song's mapping file, give PAM a MIDI port, and evaluate the
song. On strudel.cc, start `node bin/mapuzu.mjs serve` and put the two lines that it prints above
the song's code, with the song's own `pamsetup({...})` awaited.

The trap and hip hop songs play beside PAM's own patterns, so they send MIDI clock (`pamclock()`):
a standalone PAM with External Clock Sync on starts and stays with the REPL. In a DAW, take that
line out and follow PAM instead (`follow: true` in `pamsetup`). Each song's `pamsetup()` names the
port's cells as its preset has them: cell N on MIDI channel N, the pitched cells poly. The host has
to keep MIDI channels apart for that.

### In TidalCycles

Start `node bin/mapuzu.mjs tidal`, open the page it prints, and start Tidal with `mapaudio.tidal`
loaded ([README](../README.md#tidalcycles)). Each `.tidal` file opens with its setup steps in a
`{- -}` comment and then has two blocks: evaluate the `once $ pamsetup "..."` line, then the `do`
block, which sets the tempo, goes back to cycle 0 and starts the song. The trap and hip hop songs
send MIDI clock from `d1` (`pamclock`), for a standalone PAM with External Clock Sync on.

Night Shift and Cold Rail are ports of their Strudel songs, with the same patterns. Haze Garden's
`.tidal` is the whole song, 75 bars, where its Strudel file is the loop: each part comes in on its
bar, the variations change and the Vinyl Brake stops the record. TidalCycles has no `voicing()`,
so the guitar chords are written out as notes, and the koto's scale is written out as semitones. A
test checks each `.tidal` file against its Strudel file's mini-notation, setup and tempo.
There is no offline render from a `.tidal` file: `mapuzu render` reads the Strudel one.
