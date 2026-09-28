import { BookOpen, Keyboard, MonitorDown } from 'lucide-react'
import { Button, toast } from '../ui'
import { Logo } from '../Logo'
import { ExternalLink, SetGroup } from './parts'
import { promptInstall, useInstall } from '../../lib/install'
import { APP_VERSION, REPO_URL } from '../../lib/ui-constants'
import { openSample } from '../../lib/ui-import'
import { useUi } from '../../lib/ui-store'

const CREDITS: Array<{ name: string; href: string; what: string }> = [
  { name: 'Kokoro-82M', href: 'https://huggingface.co/hexgrad/Kokoro-82M', what: 'the natural voice model, by hexgrad (Apache 2.0)' },
  { name: 'kokoro-js', href: 'https://www.npmjs.com/package/kokoro-js', what: 'runs Kokoro in the browser' },
  { name: 'Transformers.js', href: 'https://huggingface.co/docs/transformers.js', what: 'on-device AI models, by Hugging Face' },
  { name: 'PDF.js', href: 'https://mozilla.github.io/pdf.js/', what: 'reads PDF files, by Mozilla' },
  { name: 'Tesseract.js', href: 'https://tesseract.projectnaptha.com/', what: 'reads text in photos and scans' },
  { name: 'Mammoth', href: 'https://github.com/mwilliamson/mammoth.js', what: 'reads Word documents' },
  { name: 'Readability', href: 'https://github.com/mozilla/readability', what: 'finds the article in a web page, by Mozilla' },
]

export function AboutTab() {
  const canInstall = useInstall((s) => !!s.event && !s.installed)

  const showShortcuts = () => {
    const ui = useUi.getState()
    ui.closeSettings()
    ui.setShortcuts(true)
  }

  const openGuide = () => {
    useUi.getState().closeSettings()
    void openSample()
  }

  const install = async () => {
    if (await promptInstall()) toast('Earful is installed. You can open it from your home screen or app list.')
  }

  return (
    <>
      <div className="set-about">
        <Logo size={64} className="set-about__logo" />
        <div>
          <h3 className="set-about__name">Earful</h3>
          <p className="set-muted">Version {APP_VERSION}</p>
        </div>
      </div>
      <p className="set-about__lead">
        Earful reads your documents aloud, highlighting each sentence and word as it goes. It is free, open source and runs entirely in your browser, even
        offline.
      </p>
      <div className="set-links">
        <ExternalLink href={REPO_URL}>Source code on GitHub</ExternalLink>
        <ExternalLink href={`${REPO_URL}/issues`}>Report a problem or suggest an idea</ExternalLink>
        <ExternalLink href="https://www.gnu.org/licenses/gpl-3.0.html">Licensed under GPL-3.0</ExternalLink>
      </div>
      <div className="set-actions">
        <Button size="sm" icon={<Keyboard />} onClick={showShortcuts}>
          Keyboard shortcuts
        </Button>
        <Button size="sm" icon={<BookOpen />} onClick={openGuide}>
          Open the welcome guide
        </Button>
        {canInstall && (
          <Button size="sm" icon={<MonitorDown />} onClick={() => void install()}>
            Install Earful
          </Button>
        )}
      </div>

      <SetGroup id="settings-privacy" title="Your privacy">
        <ul className="set-list">
          <li>No accounts, no sign-up, no ads and no tracking.</li>
          <li>Your documents are stored only on this device. Earful has no server, so they are never uploaded to us.</li>
          <li>API keys stay in this browser. They are sent only to the provider they belong to, when you use it.</li>
          <li>Premium voices and AI tools send just the text they need, straight to the provider you picked. Browser voices, natural voices and Chrome’s built-in AI never send anything.</li>
        </ul>
      </SetGroup>

      <SetGroup id="settings-credits" title="Made possible by">
        <ul className="set-list set-list--credits">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <ExternalLink href={c.href}>{c.name}</ExternalLink> <span className="set-muted">— {c.what}</span>
            </li>
          ))}
          <li className="set-muted">
            Plus lamejs, DOMPurify, marked, JSZip, Lucide icons and the Literata, Inter, Atkinson Hyperlegible and OpenDyslexic fonts. Thank you to everyone
            who builds open-source software.
          </li>
        </ul>
      </SetGroup>
    </>
  )
}
