import { useApp } from '@tldraw/editor'
import { useCallback } from 'react'
import { useValue } from 'signia-react'
import { useTranslation } from '../hooks/useTranslation/useTranslation'
import { StylePanel } from './StylePanel/StylePanel'
import { Button } from './primitives/Button'
import { Icon } from './primitives/Icon'
import { Popover, PopoverContent, PopoverTrigger } from './primitives/Popover'

export function MobileStylePanel() {
	const app = useApp()
	const msg = useTranslation()

	const currentColor = useValue(
		'current color',
		() => {
			const { props } = app
			return props ? (props.color ? app.getCssColor(props.color) : null) : 'var(--color-muted-1)'
		},
		[app]
	)

	const disableStylePanel = useValue(
		'isHandOrEraserToolActive',
		() => app.isInAny('hand', 'zoom', 'eraser'),
		[app]
	)

	const handleStylesOpenChange = useCallback(
		(isOpen: boolean) => {
			if (!isOpen) {
				app.isChangingStyle = false
			}
		},
		[app]
	)

	return (
		<Popover id="style menu" onOpenChange={handleStylesOpenChange}>
			<PopoverTrigger disabled={disableStylePanel}>
				<Button
					className="tlui-toolbar__tools__button tlui-toolbar__styles__button"
					data-testid="mobile.styles"
					style={{ color: currentColor ?? 'var(--color-text)' }}
					title={msg('style-panel.title')}
				>
					<Icon icon={currentColor ? 'blob' : 'mixed'} />
				</Button>
			</PopoverTrigger>
			<PopoverContent side="top" align="end">
				<StylePanel isMobile />
			</PopoverContent>
		</Popover>
	)
}
