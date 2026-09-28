import { useRef, type ChangeEvent } from 'react'
import { ACCEPTED_FILE_TYPES } from '../../lib/import'
import { importFiles } from '../../lib/ui-import'

/** Hidden file inputs for "Import file" and "Snap a photo". Render `inputs` once. */
export function useImportPickers() {
  const filesRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Reset so choosing the same file again still fires change.
    e.target.value = ''
    if (files.length) void importFiles(files)
  }

  const inputs = (
    <>
      <input ref={filesRef} type="file" multiple accept={ACCEPTED_FILE_TYPES} onChange={onChange} hidden tabIndex={-1} aria-hidden />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onChange} hidden tabIndex={-1} aria-hidden />
    </>
  )

  return {
    pickFiles: () => filesRef.current?.click(),
    snapPhoto: () => cameraRef.current?.click(),
    inputs,
  }
}
