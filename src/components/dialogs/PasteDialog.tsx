import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Link2 } from 'lucide-react'
import { Button, Dialog, Field, Input, Textarea } from '../ui'
import type { ImportedDoc } from '../../types'
import { importHtml, importText, importUrl } from '../../lib/import'
import { countWords } from '../../lib/text'
import { addDoc } from '../../lib/ui-import'
import { useUi } from '../../lib/ui-store'
import { errorMessage, formatWords, isAbort, isTouchDevice } from '../../lib/ui-format'
import './dialogs.css'

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

/** Text as a textarea holds it (it normalises line endings), for comparing with what was pasted. */
const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim()

/**
 * Build a document from pasted text. When the paste came with HTML (copied from a web page or
 * a word processor) the HTML is used so headings and lists survive, unless it lost text.
 */
function buildDoc(text: string, title: string, pasted: { html: string; plain: string } | null): ImportedDoc {
  if (pasted && norm(pasted.plain) === norm(text)) {
    try {
      const doc = importHtml(pasted.html, { title })
      const htmlWords = countWords(doc.blocks.map((b) => b.text).join(' '))
      if (htmlWords >= countWords(text) * 0.6) return doc
    } catch {
      /* fall back to plain text */
    }
  }
  return importText(text, title)
}

export function PasteDialog() {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [pasted, setPasted] = useState<{ html: string; plain: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const fetchCtrl = useRef<AbortController | null>(null)
  const ids = useId()

  const close = () => useUi.getState().setPaste(false)

  // Closing the dialog stops a link that is still loading.
  useEffect(() => () => fetchCtrl.current?.abort(), [])

  const keepsFormatting = !!pasted && norm(pasted.plain) === norm(text)
  const words = text.trim() ? countWords(text) : 0

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const html = e.clipboardData.getData('text/html')
    const plain = e.clipboardData.getData('text/plain')
    const ta = e.currentTarget
    const replacesAll = !ta.value.trim() || (ta.selectionStart === 0 && ta.selectionEnd === ta.value.length)
    // Let the browser insert the plain text as usual; just remember the richer version.
    setPasted(html.trim() && plain.trim() && replacesAll ? { html, plain } : null)
    setError(null)
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    if (!text.trim()) {
      setError('Paste or type some text first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const doc = buildDoc(text, title.trim(), pasted)
      await addDoc(doc, { open: true })
      close()
    } catch (err) {
      setError(errorMessage(err, 'This text could not be added. Please try again.'))
      setBusy(false)
    }
  }

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const importLink = async (e: FormEvent) => {
    e.preventDefault()
    if (fetching) return
    const target = url.trim()
    if (!target) {
      setUrlError('Enter a web address first.')
      return
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`
    fetchCtrl.current?.abort()
    const ctrl = new AbortController()
    fetchCtrl.current = ctrl
    setFetching(true)
    setUrlError(null)
    try {
      const doc = await importUrl(withScheme, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      if (title.trim()) doc.title = title.trim()
      await addDoc(doc, { open: true })
      close()
    } catch (err) {
      if (isAbort(err) || ctrl.signal.aborted) return
      setUrlError(errorMessage(err, 'This page could not be imported. Try copying its text and pasting it above.'))
      setFetching(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Paste text"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form={`${ids}-form`} loading={busy} disabled={!text.trim() || fetching}>
            Add to library
          </Button>
        </>
      }
    >
      <div className="dlg-stack">
        <form id={`${ids}-form`} className="dlg-stack" onSubmit={submit}>
          <Field label="Title (optional)" htmlFor={`${ids}-title`} hint="Leave it blank to use the first line.">
            <Input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Untitled" autoComplete="off" />
          </Field>
          <Field label="Text" htmlFor={`${ids}-text`} error={error}>
            <Textarea
              id={`${ids}-text`}
              className="dlg-paste__text"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (error) setError(null)
              }}
              onPaste={onPaste}
              onKeyDown={onTextKey}
              placeholder="Paste an article, notes, an email… anything you’d like to hear."
              data-autofocus
              spellCheck={false}
              aria-describedby={`${ids}-meta`}
            />
          </Field>
          <div className="dlg-paste__meta" id={`${ids}-meta`}>
            <span>{words ? formatWords(words) : isTouchDevice() ? '' : `Tip: press ${MOD_KEY} + Enter to add it.`}</span>
            {keepsFormatting && <span>Headings and lists from the copied page will be kept.</span>}
          </div>
        </form>

        <p className="dlg-or">or</p>

        <form className="dlg-stack dlg-stack--tight" onSubmit={importLink} noValidate>
          <Field
            label="Import from a link"
            htmlFor={`${ids}-url`}
            error={urlError}
            hint="Many websites don’t allow this. If it doesn’t work, open the page, copy the text and paste it above."
          >
            <div className="dlg-link-row">
              <Input
                id={`${ids}-url`}
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  if (urlError) setUrlError(null)
                }}
                placeholder="https://example.com/article"
                autoComplete="url"
                spellCheck={false}
              />
              <Button type="submit" icon={<Link2 />} loading={fetching} disabled={!url.trim() || busy}>
                Import link
              </Button>
            </div>
          </Field>
        </form>
      </div>
    </Dialog>
  )
}
