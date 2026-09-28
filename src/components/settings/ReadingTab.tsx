import { Field, Slider, Switch } from '../ui'
import { SetGroup } from './parts'
import { useSettings } from '../../lib/settings'

export function ReadingTab() {
  const reading = useSettings((s) => s.reading)
  const setReading = useSettings((s) => s.setReading)
  const pause = reading.paragraphPauseMs
  const pauseText = pause === 0 ? 'None' : `${Number((pause / 1000).toFixed(2))} s`

  return (
    <>
      <SetGroup
        id="settings-reading"
        title="What to read aloud"
        description="Skipped text stays on the page; it just isn’t spoken. Changes apply right away."
      >
        <div className="set-switches">
          <Switch
            checked={reading.readHeadings}
            onChange={(v) => setReading({ readHeadings: v })}
            label="Read headings"
            hint="Turn off to go straight from one section’s text to the next."
          />
          <Switch
            checked={reading.skipCitations}
            onChange={(v) => setReading({ skipCitations: v })}
            label="Skip citations and footnote numbers"
            hint="Things like [12], (Smith, 2020) and ¹ are not read out."
          />
          <Switch
            checked={reading.skipUrls}
            onChange={(v) => setReading({ skipUrls: v })}
            label="Skip web addresses"
            hint="Links such as https://example.com are not read out."
          />
          <Switch
            checked={reading.skipParentheticals}
            onChange={(v) => setReading({ skipParentheticals: v })}
            label="Skip text in brackets"
            hint="Everything inside (round brackets) is left out. Handy for dense academic writing."
          />
        </div>
      </SetGroup>

      <SetGroup id="settings-pauses" title="Pauses">
        <Field
          label={
            <span className="set-label-row">
              Pause between paragraphs <span className="set-value">{pauseText}</span>
            </span>
          }
          hint="A short break helps you notice where a new paragraph starts. It gets shorter when you speed up."
        >
          <Slider label="Pause between paragraphs" min={0} max={1000} step={50} value={pause} aria-valuetext={pause === 0 ? 'No pause' : `${pause} milliseconds`} onChange={(v) => setReading({ paragraphPauseMs: v })} />
        </Field>
      </SetGroup>
    </>
  )
}
