import { useApp } from '@tldraw/editor'
import { LANGUAGES } from './languages'

/** @public */
export function useLanguages() {
	const app = useApp()
	return { languages: LANGUAGES, currentLanguage: app.locale }
}
