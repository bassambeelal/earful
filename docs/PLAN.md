# Earful: build plan

A free, open-source alternative to Speechify (research verdict, 2026-09-27).

**Winner:** Speechify — build a free, open-source, browser-only text-to-speech document reader: offline local neural voices with no key (Kokoro via kokoro-js), instant browser voices as a fallback, and optional BYOK premium voices and AI study tools

**Runners-up:** Gauth / Photomath / Mathway: photo homework solver framed as a tutor (BYOK vision LLM, KaTeX steps, CAS-verified answers, hint mode); Gamma: AI deck generator with native editable PPTX and no watermark (BYOK). Biggest brand, but Presenton (10.8k stars, free hosted tier) weakens differentiation

## Paid product pricing

Speechify (verified Sept 2026): Free is 10 robotic voices, max 1.5x speed, 5 library files, and no OCR, offline listening, natural voices or AI. Premium is $29/mo monthly or $139/yr (about $11.58/mo), with a monthly HD-word allowance. Studio is about $288/yr. The 3-day trial auto-converts to paid. Refunds only within 7 days and under 500 HD words used; iOS purchases are final. Trustpilot and Google Play threads describe being charged $139-$229 after cancelling the trial.

## Must-have features

- Import: PDF (pdfjs-dist text layer), EPUB, DOCX, TXT/MD, pasted text or HTML (cleaned with Readability), drag-and-drop, and the PWA Web Share Target for shared text and links
- Scans and photos: detect PDFs with no text layer and OCR each page (tesseract.js in a worker, with a progress bar), plus a camera 'snap a page' capture on mobile
- Reader view: clean reflowed text with a toggle to the original PDF page view. Highlights the current sentence plus the current word, auto-scrolls to follow, and click any sentence or word to jump there
- Voice tier 0 (instant, free): Web Speech API voices, including Edge's free Microsoft 'Natural' voices, with a voice picker per language
- Voice tier 1 (free, offline, no key): Kokoro-82M via kokoro-js in a Web Worker. WebGPU fp32 when available, otherwise WASM q8 (92MB). 20+ US and UK English voices. One-time opt-in download with progress, cached for offline
- Voice tier 2 (BYOK premium): OpenAI gpt-4o-mini-tts, Gemini 2.5 Flash TTS, Groq canopylabs/orpheus-v1-english, and ElevenLabs (the with-timestamps endpoint gives exact word sync), with a cost estimate shown before generating
- Playback: speed 0.5x-4x with pitch preserved on every tier; skip back or forward by sentence and paragraph; sleep timer; keyboard shortcuts; Media Session lock-screen and headphone controls
- Smart skipping toggles: repeated headers and footers, page numbers, bracketed citations like [12] and (Smith, 2020), URLs, footnote markers; hyphenation repair across line breaks
- Library in IndexedDB: unlimited documents, resume position, progress %, last-read, search, tags; export and import the library as JSON
- Export to MP3 or WAV audiobook per document or chapter, rendered with Kokoro locally or with a BYOK voice (Speechify locks this)
- BYOK AI study tools: summarize a document or chapter, explain the selection, simplify to a chosen reading level then read it aloud, quiz me on this chapter, chat with this document, translate then read
- Accessibility and reading comfort: OpenDyslexic and Atkinson Hyperlegible fonts, adjustable size and spacing, reading ruler or focus line, dark and sepia themes, full keyboard and screen-reader support
- Installable offline PWA on GitHub Pages: app shell, model and documents all work offline
- Settings: API keys stored only on the device (optional passphrase encryption via WebCrypto), a 'test key' button per provider, clear-all-data button, and a no-telemetry statement

## Free, no key

- Every import path: PDF, EPUB, DOCX, TXT/MD, paste, share target
- OCR of scans and camera photos (tesseract.js, 100+ languages, on-device)
- Instant browser voices (Web Speech), including Edge Natural voices at no cost
- Offline neural voices (Kokoro-82M, English) with no key and no network after the first download
- Sentence and word highlighting, click-to-jump, auto-scroll
- Speed up to 4x, skip controls, sleep timer, lock-screen controls
- Header, footer and citation skipping, and hyphenation repair
- Unlimited library with resume position
- MP3/WAV audiobook export using Kokoro
- Summary via Chrome's built-in Summarizer API (Gemini Nano) where the browser supports it; hidden elsewhere
- All accessibility and reading-comfort options, plus the offline PWA

## Needs the user's own AI key

- Premium cloud voices: OpenAI gpt-4o-mini-tts (steerable 'instructions'), Gemini 2.5 Flash TTS, Groq Orpheus, ElevenLabs
- Non-English neural narration, since the Kokoro JS voices are English-only (Web Speech covers other languages for free)
- LLM summaries, explain-selection, simplify to a reading level, quiz generation, chat with the document (OpenAI, Anthropic, Gemini, OpenRouter, Groq)
- Translate a document and read the translation aloud
- Vision-LLM OCR for handwriting or messy scans when tesseract quality is poor

## Libraries

- vite
- react
- react-dom
- typescript
- vite-plugin-pwa
- kokoro-js
- @huggingface/transformers
- @met4citizen/headtts
- pdfjs-dist
- mammoth
- jszip
- @mozilla/readability
- dompurify
- tesseract.js
- idb
- @breezystack/lamejs
- zustand
- marked
- lucide-react
- coi-serviceworker

## Pitfalls

- Chrome's remote Google voices stop after about 15 seconds and never fire onboundary events (Chromium issues 41346274 and 40715888). Chunk speech by sentence using Intl.Segmenter, prefer local voices for word highlighting, and fall back to highlight timing estimated from character counts. The pause/resume keep-alive trick breaks on Android Chrome, so don't use it there.
- speechSynthesis.getVoices() loads asynchronously and differs per OS and browser. Listen for voiceschanged, persist the chosen voice by name plus language, and handle it disappearing.
- Kokoro model download ranges from 92MB (q8) to 326MB (fp32). The README recommends fp32 on WebGPU; use q8 on WASM. Make the download opt-in with a progress bar, call navigator.storage.persist(), and never block first use: start reading with Web Speech while the model downloads.
- Always run Kokoro in a Web Worker and pipeline it: split into sentences, prefetch 2-3 chunks ahead, queue playback. WASM first-audio latency can be several seconds on weak devices.
- kokoro-js does not return word timestamps. Use @met4citizen/headtts (MIT, word times and durations) or estimate word timing within each sentence. ElevenLabs with-timestamps gives exact alignment.
- Licensing: kokoro-js depends on the phonemizer package, which bundles espeak-ng (GPL-3.0) despite its Apache-2.0 metadata. License the repo GPL-3.0 to stay clean.
- GitHub Pages cannot send COOP/COEP headers, so there is no SharedArrayBuffer and onnxruntime-web WASM runs single-threaded. Either accept that, or add coi-serviceworker with COEP 'credentialless' and test that Hugging Face model fetches still work. Also set Vite base to '/<repo>/' and scope the service worker to it.
- iOS Safari: speechSynthesis stops when the screen locks, and audio must start from a user gesture. For neural or BYOK audio, play through a single HTMLAudioElement with blob URLs plus the Media Session API. The WASM model can exceed iPhone memory, so default mobile to Web Speech and offer Kokoro q8 as opt-in. WebGPU only exists on iOS 26+.
- PDF reading order: multi-column layouts, ligatures, hyphenated line breaks, tables and math read badly. Detect headers and footers as text repeated in the top and bottom bands across most pages; sort text items by column clusters; offer a 'read original order' toggle.
- Arbitrary URL import is blocked by CORS. Use paste, the share target and a bookmarklet, and do not silently route through a third-party proxy.
- Provider quirks: Anthropic needs the 'anthropic-dangerous-direct-browser-access: true' header. Gemini TTS returns raw 24kHz 16-bit PCM that must be wrapped as WAV. Groq deprecated PlayAI TTS in Dec 2025, so use canopylabs/orpheus-v1-english. OpenAI TTS input is capped per request (about 4096 characters), so chunk. Show errors for 401, 429 and CORS clearly.
- Keys in localStorage are exposed to any XSS. Use a strict CSP, no third-party scripts at runtime, and sanitize all imported HTML with DOMPurify.
- Trademark: never put 'Speechify' in the app name, logo or icon. Use it only descriptively ('a free alternative to Speechify') in the README and listing.

## Better than the paid version

- $0 forever, with no account, no 3-day trial trap, no auto-renew and no monthly word caps
- Natural neural voices free and offline (Speechify's free tier is 10 robotic voices)
- 4x speed, unlimited library, OCR and MP3 export all free (Speechify: 1.5x cap, 5 files, OCR and offline paywalled)
- Private by design: documents never leave the device, and BYOK calls go straight from the browser to the chosen provider, with no middleman server
- Pay-at-cost premium voices via your own key, with an upfront cost estimate, instead of $139-$288 a year
- Pick any provider (OpenAI, Gemini, Groq, ElevenLabs, OpenRouter, Anthropic) rather than one vendor's voice catalog
- Works offline as an installable PWA on any OS, including Linux and Chromebooks, from a single GitHub Pages URL
- Open source (GPL-3.0), auditable and forkable, with accessibility settings (dyslexia fonts, reading ruler, simplify-then-read) that paid tiers gate or lack

## Status

Done: foundation (src/types.ts, lib/text.ts, lib/db.ts, lib/settings.ts, lib/library.ts, lib/tts/types.ts).
Contract stubs, not implemented yet: lib/tts/registry.ts, lib/tts/kokoro.ts, lib/player/index.ts, lib/import/index.ts, lib/ai/index.ts.
Still to do: implement the modules, the UI (library, reader, player bar, settings, AI panel), audio export, PWA config and icons, README, LICENSE (GPL-3.0), GitHub Pages workflow, push, and a release.
