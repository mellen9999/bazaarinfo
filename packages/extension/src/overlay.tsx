import { render } from 'preact'
import { App } from './components/App'
import { I18nProvider } from './i18n-context'
import './style.css'

const root = document.getElementById('root')
if (root) render(<I18nProvider><App /></I18nProvider>, root)
