import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Home, RotateCcw } from 'lucide-react'
import { Button } from './ui'
import { replaceRoute } from '../lib/router'
import { REPO_URL } from '../lib/ui-constants'

interface State {
  error: Error | null
}

/** Catches render errors and offers a friendly way out instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept for bug reports; nothing is sent anywhere.
    console.error('Earful crashed:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  goHome = () => {
    replaceRoute('#/')
    this.reset()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <h1>Something went wrong</h1>
          <p>Earful hit an unexpected problem. Your documents and settings are safe on this device.</p>
          <div className="crash__actions">
            <Button variant="primary" icon={<RotateCcw />} onClick={this.reset}>
              Try again
            </Button>
            <Button icon={<Home />} onClick={this.goHome}>
              Back to library
            </Button>
          </div>
          <details className="crash__details">
            <summary>Technical details</summary>
            <pre>{error.message || String(error)}</pre>
            <p>
              If this keeps happening, please <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">report it on GitHub</a>.
            </p>
          </details>
        </div>
      </div>
    )
  }
}
