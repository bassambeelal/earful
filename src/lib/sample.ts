import type { Block, Chapter, ImportedDoc } from '../types'

// The "Welcome to Earful" guide added on first run (and from "Open sample").

const h = (text: string, level = 2): Block => ({ type: 'heading', text, level })
const p = (text: string): Block => ({ type: 'paragraph', text })
const li = (text: string): Block => ({ type: 'list-item', text })

const blocks: Block[] = [
  h('Welcome to Earful', 1),
  p('Earful reads anything aloud. Books, PDFs, articles, notes, even a photo of a page. Press play and listen while you walk, cook, commute or simply rest your eyes.'),
  p('This guide is a real document, so try it now. Press the play button below, or tap any sentence to start reading from there.'),

  h('What Earful does'),
  p('Import a PDF, EPUB, Word file, text file or photo, or paste some text. Earful turns it into clean, comfortable text and reads it to you, highlighting each sentence and word as it goes.'),
  p('Your place is saved automatically, so you can always pick up where you left off. Change the speed any time, from half speed up to four times as fast.'),

  h('Three kinds of voices'),
  li('Instant voices are built into your browser and device. They are free, start straight away and cover almost every language.'),
  li('Natural voices run right here on your device. They sound far more human, cost nothing and work offline after a one-time download.'),
  li('Premium voices come from services like OpenAI, Google Gemini, ElevenLabs and Groq. You bring your own key and pay the provider directly, only for what you use.'),
  p('Tap the voice button in the player to switch whenever you like.'),

  h('Free natural voices, even offline'),
  p('Open the voice picker and choose Natural voices. Earful downloads the voice model once and keeps it on your device. After that, natural voices work with no internet connection and no account.'),
  p('You can also turn a whole document or a single chapter into an MP3 audiobook with these voices, completely free.'),

  h('Bring your own key'),
  p('Want premium voices or AI study tools? Add your own API key in Settings. Earful sends each request straight from your browser to the provider you picked. There is no Earful server in the middle and no subscription.'),
  p('The AI tools can summarise a document, answer your questions about it, quiz you, explain a tricky passage, simplify the text or translate it, and then read the result aloud.'),

  h('Private by design'),
  p('Your documents are stored only in this browser, on this device. Your keys stay here too. Earful has no accounts, no tracking and no ads. You can export your library or delete everything at any time in Settings.'),

  h('Keyboard shortcuts'),
  li('Space or K: play or pause.'),
  li('Left and right arrows: previous or next sentence.'),
  li('Shift and an arrow: previous or next paragraph.'),
  li('Plus and minus: faster or slower.'),
  li('Slash: search your library. Question mark: show every shortcut.'),

  h('Tips'),
  li('Select any text to play from that spot, copy it or ask the AI to explain it.'),
  li('Use the Aa button to change the font, text size, spacing and theme. The Hyperlegible and Dyslexic fonts are there if they help you.'),
  li('Turn on focus mode to dim everything except the sentence being read.'),
  li('Install Earful from your browser to use it like an app, even offline.'),
  p('That is everything. Import your first document and enjoy the listen.'),
]

const chapters: Chapter[] = blocks.flatMap((b, i) => (b.type === 'heading' && b.level === 2 ? [{ title: b.text, block: i }] : []))

export const SAMPLE_DOC: ImportedDoc = {
  title: 'Welcome to Earful',
  author: 'The Earful team',
  source: 'sample',
  lang: 'en',
  blocks,
  chapters,
}

/** A fresh copy, so callers can't mutate the shared sample. */
export function sampleDoc(): ImportedDoc {
  return { ...SAMPLE_DOC, blocks: SAMPLE_DOC.blocks.map((b) => ({ ...b })), chapters: SAMPLE_DOC.chapters.map((c) => ({ ...c })) }
}
