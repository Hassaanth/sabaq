# Sabaq — Quran recitation tracker (demo)

Recite into the mic, from any surah and any ayah. Sabaq finds where you are, follows you word by word,
and only flags a mistake when the evidence says it is one.

## Use it on your phone

Open **https://hassaanth.github.io/sabaq/** in **Safari** (iPhone) or **Chrome** (Android), tap the mic, allow
the microphone, and recite. On iPhone, Dictation must be on: Settings > General > Keyboard > Enable Dictation.

**iPhone: keyboard dictation (most reliable).** Safari's speech recognition is unreliable on iPhone (it can be
refused with `service-not-allowed`, and it stops after each phrase). Sabaq can instead follow the iPhone
keyboard's own dictation: keyboard button › **Recite with keyboard dictation** (it also opens automatically if
Safari refuses). Once: Settings › General › Keyboard › Keyboards › Add New Keyboard › Arabic, and Enable
Dictation. Then tap the box, switch to the Arabic keyboard (🌐), tap the 🎤 key and recite. Tap Done to finish.

With Safari's recognizer on iPhone, each phrase is its own short session and Sabaq restarts it; if iOS refuses a
restart without a tap, it says so ("Tap the mic to go on").
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

`node tools/build-site.js` regenerates `index.html` (the GitHub Pages page) from `app.html`.

Tests:
```
node tests/engine.test.js     # 65 scenario tests, incl. teacher mode and moving on
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

For reciting from memory, eyes closed. The moment a word is skipped, changed, or said with a different
letter (الجنوب for الجنود), Sabaq stops you on that word: it turns red and a low two-note sound plays
(plus a vibration on phones), then **a qari recites the correct word**. It will not move on until you
say it (the word alone, or go back and restart the phrase). Then a chime plays and the word gets a green ✓.
Say it wrong again and the qari corrects you again.

To move on after a correction, either **repeat the word** or **repeat the ayah from its start** (any length).
A retry the recogniser hears slightly differently is accepted, as long as it isn't the same mistake again.
After 3 wrong tries at one word it lets you move on, and **Move on** in the status line does it at any time;
the word stays marked for review in the summary.

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
