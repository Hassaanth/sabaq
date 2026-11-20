# Sabaq — Quran recitation tracker (demo)

Recite into the mic, from any surah and any ayah. Sabaq finds where you are, follows you word by word,
and only flags a mistake when the evidence says it is one.

## Use it on your phone

Open **https://hassaanth.github.io/sabaq/** in **Safari** (iPhone) or **Chrome** (Android), tap the mic, allow
the microphone, and recite.

**Speech recognition, picked automatically:**

* **Computer / Android (Chrome, Edge):** the browser's live recognition (Google's servers). It streams each word
  back at once, so the highlight follows you instantly.
* **iPhone / Safari: Sabaq's speech server** when one is available. This is how Tarteel works: their app streams
  your voice to their servers (NVIDIA Riva on GPUs), where the recognition runs. Sabaq's server (`server/`) runs
  Tarteel's open Quran model natively; the phone uploads each bit of audio once (about 32 KB/s) and gets the
  words back within about a second. See **Speech server** below.
* **Sabaq's own Quran model in the browser**, when there is no server (or it can't be reached): slower on a phone.
  Apple's recogniser (Siri) is not used unless chosen under the keyboard button › Speech recognition.
  The in-browser model: Sabaq records the
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

## Speech server

`server/asr-server.js` serves the Sabaq website **and** the recognition (WebSocket at `/asr`) from one address:

```
cd server
npm install
npm start            # http://localhost:8787
```

The fast model's files (`server/models/pc/model.int8.onnx`, `tokens.txt`) are not in the repository (131 MB).
Build them once from NVIDIA's own checkpoint with `server/build-ctc-model.py` (its header has the four commands;
needs Python with `onnx onnxruntime numpy pyyaml`), or set `CTC_URL` to a folder that hosts both files. The
Docker image builds them itself. (The int8 export the server used to download, from OmarrGhorab/openbot-personal,
was deleted in November 2026; the rebuilt model reads 108 ayahs by 4 qaris word for word the same.)

**Models (chosen by measurement on Al-Mulk 1–10, Alafasy / Husary / Minshawi):**

| Model | Words right | Reading 1 s / 7 s of audio | Used for |
|---|---|---|---|
| NVIDIA Arabic FastConformer, CTC (`stt_ar_fastconformer_hybrid_large_pc_v1.0`, int8, sherpa-onnx) | 117 / 114 / 117 | **31 ms / 152 ms** | live readings and phrase readings |
| Tarteel's Whisper base Quran model | 117 / 117 / 117 | ~800 ms / ~1,500 ms | the double-check before a stop |

The FastConformer is the same model family Tarteel runs (NVIDIA NeMo); unlike Whisper, which always processes a
30-second window and writes text out piece by piece, it reads only the audio you said, in one pass. The
double-check uses a different kind of model, so a stop needs two independent readings to agree.

**Streaming.** While you recite, the phone streams its audio to the server every 80 ms; the server reads the
newest audio of the phrase whenever its fast model is free (about every 80–100 ms) and sends the words back, so
no reading waits in a queue going stale. Each live reading gets 0.6 s of faint room noise after the audio: an
offline model holds back the newest word at the very end of what it hears, and with a little "after" it writes it
out ~0.2 s sooner and makes up half as many words (measured on Al-Mulk 2–5). The highlight sits on the word being
said and moves on when the next word is heard starting, never sooner (a word the model already names may still be
going on, e.g. a long madd). Measured on Al-Mulk 1–5 at phone CPU speed (word end → highlight moves past it):

| Recitation pace | Typical lag | 90% of words within | Words followed |
|---|---|---|---|
| Alafasy, normal (0.8 words/s with pauses) | 0.4–0.5 s | 0.8 s | 60/60 |
| 1.6x faster (1.3 words/s) | 0.3–0.4 s | 0.6–0.7 s | 60/60 |
| 2.2x faster (1.7 words/s, hadr) | 0.4 s | 0.6–0.7 s | 60/60 in 6 of 8 runs |

Most of what is left is the model itself: it writes a word once most of it has been said (~0.25–0.4 s in).
Tried and measured: reading the model's raw per-frame probabilities (run directly with onnxruntime) to notice the
next expected word's start sooner, as reading-tutor and lyrics-following systems do. With this model it gained
0.03 s on average (Al-Mulk 1–5): its probabilities only rise once it commits to a word, so it was not adopted.
No streaming Arabic model usable for a paid app has less delay (the open ones look ~1 s ahead or are non-commercial).

**Between confirmations** the word being said fills in (right to left, karaoke style) at the reciter's own pace,
learnt from each step from one word to the next. It stops at 85% and waits (a long madd, a pause); the highlight
moves to the next word only once it is heard. The microphone is captured with an AudioWorklet (audio every ~21 ms,
nothing lost while the page is busy), with the older ScriptProcessor as the fallback.
At 2.5x and beyond the (time-stretched) test audio itself gets garbled. A double-check of a suspected mistake
(~2 s) no longer holds up following the words after it.
Credits: NVIDIA (CC-BY-4.0; encoder export by LukeJacob2023 on Hugging Face), Tarteel AI (Apache-2.0); the word
check follows Tilawa (yazinsai/tilawa, MIT).

A page served by the server finds it by itself (it answers `/health`). Any other page can be pointed at one with
`?asr=wss://host/asr` (remembered; `?asr=off` to stop). A phone needs HTTPS for the microphone, so the server must
be reached through HTTPS: a cloud host (`server/Dockerfile` runs as a free Hugging Face Docker Space, port 7860)
or a tunnel to a computer running it. `MODEL=…` picks another Quran Whisper ONNX model, `THREADS=…` the CPU
threads. If the connection drops mid-recitation (a tunnel hiccup, the server restarting, the phone changing
network), the phone reconnects (after 0.3, 1, 2 and 4 s) and re-sends the phrase in progress. Only after that does the
slower in-browser model take over, said on screen, and the phone tries the server again every 15 s and switches back.

### Server settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 8787 | HTTP + WebSocket port |
| `THREADS` | half the cores, max 4 | CPU threads per model |
| `MAX_CONNS` | 24 | reciters connected at once; more are refused (the phone falls back) |
| `MAX_JOBS` | 6 | phrase readings + double-checks one reciter may have waiting |
| `ORIGINS` | (any) | comma list of sites allowed to connect, e.g. `https://hassaanth.github.io` |
| `PAD` | 0.6 | seconds of faint noise after each live reading (see Streaming) |
| `LOG_EVERY` | 60 | seconds between activity summaries in the log; 0 = off |
| `HF_CACHE` | system temp | where the models are downloaded (keep it on a persistent disk) |

Reciters take turns on each model lane, so one person's long backlog can't hold up the others. Each connection
is checked every 20 s (a phone that vanished is let go within ~40 s). On SIGTERM/SIGINT the server stops taking
new reciters, tells the open ones (their phones reconnect by themselves), lets running readings finish, and exits.

`GET /health` reports: ready, models, connections, memory, and rolling timings per kind of reading
(`msMedian`/`msP90` = model time, `waitMedian`/`waitP90` = audio arrived → model started).

### Deploying the server permanently

The website stays on GitHub Pages; only the speech server needs a host that is always on, with HTTPS (the phone
needs it for the microphone) and WebSockets. Measured needs: about 1.3 GB of memory with both models loaded, and
CPU only (no GPU). See "Measured" below for how much CPU.

1. Build and run the container on the host (any Linux VM, or a container service):
   ```
   docker build -f server/Dockerfile -t sabaq .
   docker run -d --restart=always -p 8787:7860 -e THREADS=2 -e ORIGINS=https://hassaanth.github.io -v sabaq-models:/tmp/sabaq-hf-cache sabaq
   ```
   or without Docker: `cd server && npm install && PORT=8787 THREADS=2 node asr-server.js` under a process manager
   (systemd, pm2) that restarts it.
2. Put HTTPS in front (Caddy does it in one line: `your.domain { reverse_proxy localhost:8787 }`), or use the host's
   own HTTPS.
3. Point the website at it: set `"url": "https://your.domain"` in `asr-url.json` and push; every phone then finds
   the server by itself. (Or open the site once with `?asr=wss://your.domain/asr`.)
4. Check: `https://your.domain/health` shows `"ready": true`.

Options: a small always-on VM (2 vCPU / 4 GB, roughly $4–6 a month at Hetzner or similar), or Oracle Cloud's
Always-Free Arm VM (sherpa-onnx ships Linux arm64 builds). A free Hugging Face Docker Space also runs the Dockerfile,
but it sleeps when unused and wakes slowly, so the first recitation after a quiet spell falls back to the phone.

### Measured (November 2026, Al-Mulk 1–5, phone CPU emulated at 4× slower, server on this PC)

Where the time goes for one live reading (`?debug=1` shows these on screen; median / 90th percentile, ms):

| Stage | 4 server threads | 2 server threads (≈ small cloud VM) |
|---|---|---|
| newest audio reaches the page → words back (round trip) | 150 / 300 | 162 / 355 |
| … of which the model | 110 / 250 | 123 / 303 |
| … of which waiting on the server | 17 / 66 | 26 / 72 |
| … of which network (local here; add your link's round trip) | 1 / 3 | 1 / 3 |
| words back → Quran position updated | 0 / 1 | 0 / 1 |
| words back → highlight drawn | 4 / 7 | 4 / 7 |
| **word ends → highlight moves past it** | **0.4–0.5 s / 0.8–0.9 s** | **0.4 s / 0.8 s** |

So the page itself adds under 10 ms; the rest is the model (it writes a word once most of it has been said) plus
the round trip. Server memory: about 1.0–1.3 GB. A phrase's full reading takes ~160 ms (p90 ~290 ms); a
double-check with Whisper ~1.7 s (p90 2.2 s), on its own lane so it never holds up the live highlight.

Fast recitation (2.2×, time-stretched Alafasy), runs without any false mark: at the start of this round 1 of 2
lag-test runs, and 0 of 2 lag runs + 0 of 1 session run just before the fix below; after it, 2 of 2 lag runs and
3 of 6 runs of the harder `fast22` session (`ONLY=fast22 node tests/sessions.cjs`: shorter breaths). Small samples:
2.2× is better, not solved. Normal speed: no false marks before or after.

#### Keeping up with a fast reciter (hadr)

Above 1.3 words/s (measured from the highlight's own steps over the last 4 s), Sabaq changes four things.

- **Passes words sooner.** The word being said is passed as soon as the live reading has all its letters. It doesn't wait for the next word to be heard starting. An ayah's last word is the exception, because it is held long at any pace.
- **Keeps moving past a suspected word.** The highlight carries on past a word that is being double-checked; the word keeps its "checking" underline. It no longer waits until the phrase ends and the check is done. A confirmed mistake still stops there.
- **Doesn't stop on unclear audio.** If both readings miss a word but disagree about what was said there, the word is marked "not clearly heard" and nothing stops. A real slip sounds alike to both readings.
- **Never gets stuck after a stop.** At any pace, if the reciter is still reciting 2 s after a stop, the next words are followed (the word stays marked). Before, the app waited for them to pause, up to 15 s.

Two smaller changes:

- While a phrase is being double-checked, the next phrase is previewed on top of it.
- Audio goes to the server every 40 ms instead of every 80 ms.

Measured (Al-Mulk 1–5, lag median / p90 / max, words followed):

| Speed | Before | After |
|---|---|---|
| 1× | 0.4 / 0.8 / 1.7 s, 60/60 | unchanged by design (slower than 1.3 words/s) |
| 2× (1.6 words/s) | 0.4 / 0.8 / 1.4 s, 60/60 | 0.3 / 0.7–0.8 / 0.9–1.2 s, 60/60 (3 runs) |
| 2.5× (2 words/s) | stuck after a false stop: 48/60, rest lost | 0.5–0.6 / 2.4–2.9 / 3.3–5.0 s, 60/60 (2 runs) |
| 3× | 24/60 | 54–58/60 (the stretched audio is garbled for both models) |

`fast22` session: 2 of 2 runs clean (was 3 of 6), so the sample is small. At 2.5× one false stop is still common near 67:4–5; it now costs a few seconds instead of the rest of the recitation. Real fast recitation
sounds cleaner than time-stretched audio, but this was not tested with a real fast reciter. The phone now reports its
timings to the server log every 30 s (`phone timing:`), along with each stop (`phone stop:`) and each word let through as unclear
(`phone unclear:`), so a real session can be checked.
Disconnect test (server killed 14 s in): reconnected by itself, 60/60 words followed, no false marks.

### How a suspected mistake is checked

1. A live reading that sees a mistake only marks the word "checking" (dashed amber underline) and ends the phrase
   early, so the check comes at once. It never stops anyone by itself.
2. The phrase's full reading must show the mistake too.
3. **Word check** (the way Tilawa checks a mistake, `server/ctc-score.js`): the fast model gives a probability for
   every word piece every 80 ms. The server lines the *correct* words around the suspected one up with that audio
   and measures how much worse they fit than the model's own reading. Within 4: the model garbled them and the
   reciter was right; no stop, the words count as right. Worse by 12 or more: the reciter said something else; stop
   at once. In between, the steps below decide. One model run plus a few milliseconds (~0.3–0.5 s in all, instead
   of ~2 s for Whisper). Measured on 1,076 words recited by 4 qaris: correct words fit within 4 in 99.5%;
   a different word, a word 1–2 letters off, or a skipped word misses by 12 or more in 95–100%. An added word is
   mostly left to the steps below. Word gaps are ignored, so a join (wasl) or the Quran's own spelling (أمن for
   أم من) is no difference. Each decision is reported to the server log as `phone check`.
4. A second, different model (Whisper) reads the audio again, with the end of the previous phrase in front. If
   Whisper loops (a repeated 3-word run) or returns nothing, the fast model re-reads with that context instead.
5. **The right audio:** if the suspected word was heard in an earlier phrase (fast recitation can cut a phrase
   right next to a word), the tracker goes back to where that phrase began (up to 3 phrases / 14 s), the second
   reading covers all of that audio, and those phrases are judged again from both readings.
6. A second reading that shows no mistake *and fits the Quran text* (no stray or unplaced words) clears it; a
   reading that merely avoids a stop is not enough. Otherwise each word where the two readings differ is decided
   by what fits the text, and the stop happens only if a mistake is left that both readings heard.
The "checking" mark disappears once this is decided.

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

**A simulated person reciting:** http://localhost:5173/?fakemic=1&usersim=1 also loads `tests/user-sim.js`, which
cuts real recitation at word boundaries (Quran.com timings) and plays a script of what someone says, with
pauses, restarts, skipped and wrong words, and taps on the mic, and records what the app shows:
`await __sim.run([{tap: true}, '67:1', {pause: 1200}, '67:2:1-5', {pause: 2500}, '67:2:6-11', '67:4:1-3', '67:4:5-10',
{until: 'Your turn'}, '67:4:4-10']); __sim.report()`.

`node tools/build-site.js` regenerates `index.html` (the GitHub Pages page) from `app.html`.

Tests:
```
node tests/engine.test.js     # 90 scenario tests, incl. teacher mode, moving on, fast joined words
node tests/sessions.cjs       # realistic sessions through the real mic path (needs Playwright; see the file)
node tests/stress.test.js     # 60,000-word noisy-recitation simulation
```

### Testing on a real iPhone

1. Start the server and the tunnel on the computer: `cd server && node start-public.js` (it prints the public
   HTTPS address and publishes it in `asr-url.json`).
2. On the iPhone, in Safari, open that address with `?debug=1` (e.g. `https://xxxx.trycloudflare.com/?debug=1`).
   Allow the microphone. The corner box shows the timings, the capture path (`worklet` or `script`), the
   microphone's real sample rate, and whether the server or the phone's own model is reading.
3. Things to try: recite normally; recite fast; repeat a word and an ayah; pause 5 s; say a wrong word; skip a word;
   start mid-surah; lock the screen for a few seconds and come back (it should say to tap the mic if iOS took the
   microphone away); switch Wi-Fi off and on mid-ayah (it should say "Reconnecting…" and carry on).
4. If something looks wrong, a screenshot of the debug box plus what you recited is enough to trace it.

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

**Mistakes stay on the page.** A word you were stopped on turns red. Once you put it right it turns green with a
red line under it and a ✓ ("mistake, then fixed"), so you can see afterwards where you slipped. A word the qari
had to give you that you then went past stays red ("needed help"); both are in the review list at the end.

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
