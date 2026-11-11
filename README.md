# Sabaq — Quran recitation tracker (demo)

Recite into the mic, from any surah and any ayah. Sabaq finds where you are, follows you word by word,
and only flags a mistake when the evidence says it is one.

## Use it on your phone

Open **https://hassaanth.github.io/sabaq/** in **Safari** (iPhone) or **Chrome** (Android), tap the mic, allow
the microphone, and recite.

**Two speech recognisers, picked automatically:**

* **Chrome, Edge, Android:** the browser's own recognition (Google's), the same as on a computer.
* **iPhone, Safari, Firefox:** **Sabaq's own Quran speech model.** iPhone browsers can only use Apple's speech
  engine, which is unreliable for this (`service-not-allowed`, stops after every phrase). So Sabaq records the
  microphone itself and runs Tarteel's open model trained on Quran recitation
  ([tarteel-ai/whisper-tiny-ar-quran](https://huggingface.co/tarteel-ai/whisper-tiny-ar-quran), Apache-2.0;
  ONNX build `Sharjeelbaig/whisper-tiny-ar-quran-onnx`) on the phone, in a background worker (`asr-worker.js`,
  Transformers.js). It downloads once (about 38 MB) and is then cached. Speech is cut into phrases where you
  pause; each phrase takes about 2 s to transcribe (live updates while you recite); nothing is sent to a server.

**Tracking while you recite.** The model re-reads what you have said so far every moment and locks in
words as soon as they are confirmed correct, so the highlight moves word by word, not phrase by phrase.
Anything that looks like a mistake waits for the phrase's final reading and a double-check (read again with
the end of the previous phrase as context), so a one-off garble never stops you. On a slower phone the app
measures its own speed and, if live re-reading would fall behind, reads each stretch once in chunks cut at
the gaps between words, so the delay stays constant. On the website the model uses several CPU threads
(`coi-sw.js`, a tiny service worker, adds the isolation headers GitHub Pages can't send). The speed on your
device is shown under the keyboard button › Speech recognition.

The mic button's ring follows your voice, so you can see you are being heard, and the status line says
when a phrase was heard and is still being read. The model starts downloading as soon as the page opens.
With the model, a result that would stop you is double-checked first: the same audio is transcribed again,
and Sabaq stops only if both readings show the mistake (the small model occasionally garbles a word once).

Choose manually under the keyboard button › Speech recognition. On real recitation by Mishary Alafasy (Al-Mulk
1–5, Al-Buruj 12–19) the model transcribed every word and Sabaq raised no false flags; it reports wrong and
missing words as heard instead of "autocorrecting" them, which teacher mode depends on.

Headphones help: the qari's correction then doesn't reach the mic, and iPhones can play sound quietly
through the earpiece while the mic is on. The screen is kept awake while listening.

## Run it locally

```
node serve.js
```
Open http://localhost:5173 in Chrome or Edge (they ship Arabic speech recognition). No mic? Use
"Watch the demo", or the keyboard button to type/paste Arabic words.

Test phone speech behaviour without a phone: http://localhost:5173/?fakesr=ios (or `=android`) loads
`tests/fake-sr.js`; then drive it from the console with `await __say([...words])` and `__endSession()`.

Test the Quran model end to end without a microphone: http://localhost:5173/?fakemic=1 loads `tests/fake-mic.js`,
which replaces the microphone with audio you schedule, e.g. real recitation cut at word boundaries:
`await __play([{ url: 'https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/85.mp3', from: 141835, to: 143895 }])`
(word timings: `api.qurancdn.com/api/qdc/audio/reciters/7/audio_files?chapter=85&segments=true`).
Set `window.__asrLog = []` first to log what the model heard.

`node tools/build-site.js` regenerates `index.html` (the GitHub Pages page) from `app.html`.

Tests:
```
node tests/engine.test.js     # 67 scenario tests, incl. teacher mode and moving on
node tests/stress.test.js     # 60,000-word noisy-recitation simulation
```

## Files

| File | What it is |
|---|---|
| `engine.js` | The tracking engine (no UI). Runs in the browser and in Node. |
| `app.html`, `app.js` | The app: mushaf view, mic, memorization mode, summary. |
| `quran-data.js` | Full Quran text, Tanzil (tanzil.net) Uthmani for display + simple script for matching. |
| `serve.js` | Tiny local server. |
| `tools/build-data.js` | Rebuilds `quran-data.js` from the alquran.cloud `quran-uthmani` and `quran-simple-clean` editions. |
| `audio/` | Bundled qari word recordings: Al-Fatiha, Al-Mulk and all of Juz ʿAmma (78–114). |
| `tools/build-audio.js` | Rebuilds `audio/` from Quran.com's word-by-word recitation (needs `lamejs` + `mpg123-decoder`). |

## Teacher mode (on by default)

For reciting from memory, eyes closed, hands free (no buttons to press). The moment a word is skipped,
changed, or said with a different letter (الجنوب for الجنود), Sabaq stops you on that word: it turns red and a
low two-note sound plays (plus a vibration on phones). Then:

1. **You get 3 seconds to find it yourself.** Say the word (or go back and restart the phrase) and a chime
   plays, the word gets a green ✓, and you carry on. An attempt still being heard when the 3 s end is waited for.
2. **If you stay silent, or say it wrong, a qari recites the correct word.**
3. **Then repeat the word, or the ayah from its start, and move on.** Say it wrong again and the qari
   corrects you again; after 3 wrong tries it lets you move on (the word stays marked for review).

A retry the recogniser hears slightly differently is accepted, as long as it isn't the same mistake again.

* Words you were already saying when the sound played do not set it off again; if you keep going anyway, it signals again after 5 words.
* Restarts never stop you. Spelling-only differences (داود / داوود) never stop you.
* A slip on the last word of an ayah is judged after a 1-second pause, so it is caught even if you stop there.
* While the qari speaks (and briefly after), the mic input is ignored so the qari's voice is not taken as yours. Headphones are still best.
* In teacher mode a small word the recogniser drops (e.g. كل, في) also stops you, because it can't tell a dropped word from a skipped one. Saying the word clears it.

Qari audio: bundled for the demo surahs (works everywhere, including the claude.ai page). Run locally, any
other word is fetched from Quran.com (audio.qurancdn.com). Audio © Quran.com; check their terms before shipping.
The toggle is the octagon button in the header.

## How the tracking avoids false mistakes

* **Restarts and repeats are free.** Going back to re-begin an ayah, or stuttering a word, is recognised and never counted.
* **It waits for proof.** A word is judged only after the next words confirm what happened. When two explanations fit equally (a phrase that appears twice in an ayah), it waits for more words instead of guessing.
* **Recogniser noise is not your fault.** Short words speech recognition tends to drop are marked "not clearly heard", not "skipped". Spelling differences (ذلك / ذالك) count as correct. Hesitation sounds are ignored.
* **Confidence levels.** Red = a different word or a skipped run of words. Amber "check" = close, worth a listen (heard text shown). Self-corrections clear the mistake.
* **Recite from anywhere.** A whole-Quran index locates you from a few words (590/600 random starting points exact in testing; the rest are passages that are word-for-word identical elsewhere, where it waits for more words).

## Limits of this demo

* Speech comes from the browser's general Arabic recognizer, which is not trained on tajweed recitation. The engine is built to tolerate that, but the production step is a Quran-tuned speech model (for example a Whisper model fine-tuned on recitation) running on a server or on-device.
* It checks *words*, not tajweed rules (madd, ghunnah, makharij). That needs an audio-level model.
* On a phone, the microphone needs HTTPS: host the four files on any HTTPS static host.
