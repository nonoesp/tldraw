import { Matrix2d, snapAngle, Vec2d } from '@tldraw/primitives'
import {
	createShapeId,
	TLDrawShape,
	TLDrawShapeSegment,
	TLSizeType,
	Vec2dModel,
} from '@tldraw/tlschema'
import { last, structuredClone } from '@tldraw/utils'
import { DRAG_DISTANCE } from '../../../../constants'
import { uniqueId } from '../../../../utils/data'
import { TLDrawUtil } from '../../../shapeutils/TLDrawUtil/TLDrawUtil'
import { TLEventHandlers, TLPointerEventInfo } from '../../../types/event-types'

import { StateNode } from '../../StateNode'

export class Drawing extends StateNode {
	static override id = 'drawing'

	info = {} as TLPointerEventInfo

	initialShape?: TLDrawShape

	util = this.app.getShapeUtil(TLDrawUtil)

	isPen = false

	segmentMode = 'free' as 'free' | 'straight' | 'starting_straight' | 'starting_free'

	didJustShiftClickToExtendPreviousShapeLine = false

	pagePointWhereCurrentSegmentChanged = {} as Vec2d

	pagePointWhereNextSegmentChanged = null as Vec2d | null

	lastRecordedPoint = {} as Vec2d
	mergeNextPoint = false
	currentLineLength = 0

	canDraw = false

	onEnter = (info: TLPointerEventInfo) => {
		this.info = info
		this.canDraw = !this.app.isMenuOpen
		this.lastRecordedPoint = this.app.inputs.currentPagePoint.clone()
		if (this.canDraw) {
			this.startShape()
		}
	}

	onPointerMove: TLEventHandlers['onPointerMove'] = () => {
		const {
			app: { inputs },
		} = this

		if (this.isPen !== inputs.isPen) {
			// The user made a palm gesture before starting a pen gesture;
			// ideally we'd start the new shape here but we could also just bail
			// as the next interaction will work correctly
			this.cancel()
		}

		// If we came in from a menu but have no started dragging...
		if (!this.canDraw && inputs.isDragging) {
			this.startShape()
			this.canDraw = true // bad name
		}

		if (this.canDraw) {
			// Don't update the shape if we haven't moved far enough from the last time we recorded a point
			if (inputs.isPen) {
				if (Vec2d.Dist(inputs.currentPagePoint, this.lastRecordedPoint) >= 1 / this.app.zoomLevel) {
					this.lastRecordedPoint = inputs.currentPagePoint.clone()
					this.mergeNextPoint = false
				} else {
					this.mergeNextPoint = true
				}
			} else {
				this.mergeNextPoint = false
			}

			this.updateShapes()
		}
	}

	onKeyDown: TLEventHandlers['onKeyDown'] = (info) => {
		if (info.key === 'Shift') {
			switch (this.segmentMode) {
				case 'free': {
					// We've just entered straight mode, go to straight mode
					this.segmentMode = 'starting_straight'
					this.pagePointWhereNextSegmentChanged = this.app.inputs.currentPagePoint.clone()
					break
				}
				case 'starting_free': {
					this.segmentMode = 'starting_straight'
				}
			}
		}
		this.updateShapes()
	}

	onKeyUp: TLEventHandlers['onKeyUp'] = (info) => {
		if (info.key === 'Shift') {
			this.app.snaps.clear()

			switch (this.segmentMode) {
				case 'straight': {
					// We've just exited straight mode, go back to free mode
					this.segmentMode = 'starting_free'
					this.pagePointWhereNextSegmentChanged = this.app.inputs.currentPagePoint.clone()
					break
				}
				case 'starting_straight': {
					this.pagePointWhereNextSegmentChanged = null
					this.segmentMode = 'free'
					break
				}
			}
		}

		this.updateShapes()
	}

	onExit? = () => {
		this.app.snaps.clear()
		this.pagePointWhereCurrentSegmentChanged = this.app.inputs.currentPagePoint.clone()
	}

	getIsClosed(segments: TLDrawShapeSegment[], size: TLSizeType) {
		const strokeWidth = this.app.getStrokeWidth(size)
		const firstPoint = segments[0].points[0]
		const lastSegment = segments[segments.length - 1]
		const lastPoint = lastSegment.points[lastSegment.points.length - 1]

		return (
			firstPoint !== lastPoint &&
			this.currentLineLength > strokeWidth * 4 &&
			Vec2d.Dist(firstPoint, lastPoint) < strokeWidth * 2
		)
	}

	private startShape() {
		const {
			inputs: { originPagePoint, isPen },
		} = this.app

		this.app.mark('draw create start')

		this.isPen = isPen

		const pressure = this.isPen ? this.info.point.z! * 1.25 : 0.5

		this.segmentMode = this.app.inputs.shiftKey ? 'straight' : 'free'

		this.didJustShiftClickToExtendPreviousShapeLine = false

		this.lastRecordedPoint = originPagePoint.clone()

		if (this.initialShape) {
			const shape = this.app.getShapeById<TLDrawShape>(this.initialShape.id)

			if (shape && this.segmentMode === 'straight') {
				// Connect dots

				this.didJustShiftClickToExtendPreviousShapeLine = true

				const prevSegment = last(shape.props.segments)
				if (!prevSegment) throw Error('Expected a previous segment!')
				const prevPoint = last(prevSegment.points)
				if (!prevPoint) throw Error('Expected a previous point!')

				const { x, y } = this.app.getPointInShapeSpace(shape, originPagePoint).toFixed()

				const pressure = this.isPen ? this.info.point.z! * 1.25 : 0.5

				const newSegment: TLDrawShapeSegment = {
					type: this.segmentMode,
					points: [
						{
							x: prevPoint.x,
							y: prevPoint.y,
							z: +pressure.toFixed(2),
						},
						{
							x,
							y,
							z: +pressure.toFixed(2),
						},
					],
				}

				// Convert prevPoint to page space
				const prevPointPageSpace = Matrix2d.applyToPoint(
					this.app.getPageTransformById(shape.id)!,
					prevPoint
				)
				this.pagePointWhereCurrentSegmentChanged = prevPointPageSpace
				this.pagePointWhereNextSegmentChanged = null
				const segments = [...shape.props.segments, newSegment]

				this.currentLineLength = this.getLineLength(segments)

				this.app.updateShapes([
					{
						id: shape.id,
						type: 'draw',
						props: {
							segments,
							isClosed: this.getIsClosed(segments, shape.props.size),
						},
					},
				])

				return
			}
		}

		// Create a new shape

		this.pagePointWhereCurrentSegmentChanged = originPagePoint.clone()
		const id = createShapeId()
		this.app.createShapes([
			{
				id,
				type: 'draw',
				x: originPagePoint.x,
				y: originPagePoint.y,
				props: {
					isPen: this.isPen,
					segments: [
						{
							type: this.segmentMode,
							points: [
								{
									x: 0,
									y: 0,
									z: +pressure.toFixed(2),
								},
							],
						},
					],
				},
			},
		])

		this.currentLineLength = 0
		this.initialShape = this.app.getShapeById<TLDrawShape>(id)
	}

	private updateShapes() {
		const { inputs } = this.app
		const { initialShape } = this

		if (!initialShape) return

		const {
			id,
			props: { size },
		} = initialShape

		const shape = this.app.getShapeById<TLDrawShape>(id)!

		if (!shape) return

		const { segments } = shape.props

		const { x, y, z } = this.app.getPointInShapeSpace(shape, inputs.currentPagePoint).toFixed()

		const newPoint = { x, y, z: this.isPen ? +(z! * 1.25).toFixed(2) : 0.5 }

		switch (this.segmentMode) {
			case 'starting_straight': {
				const { pagePointWhereNextSegmentChanged } = this

				if (pagePointWhereNextSegmentChanged === null) {
					throw Error('We should have a point where the segment changed')
				}

				const hasMovedFarEnough =
					Vec2d.Dist(pagePointWhereNextSegmentChanged, inputs.currentPagePoint) > DRAG_DISTANCE

				// Find the distance from where the pointer was when shift was released and
				// where it is now; if it's far enough away, then update the page point where
				// the current segment changed (to match the pagepoint where next segment changed)
				// and set the pagepoint where next segment changed to null.
				if (hasMovedFarEnough) {
					this.pagePointWhereCurrentSegmentChanged = this.pagePointWhereNextSegmentChanged!.clone()
					this.pagePointWhereNextSegmentChanged = null

					// Set the new mode
					this.segmentMode = 'straight'

					const prevSegment = last(segments)
					if (!prevSegment) throw Error('Expected a previous segment!')

					const prevLastPoint = last(prevSegment.points)
					if (!prevLastPoint) throw Error('Expected a previous last point!')

					let newSegment: TLDrawShapeSegment

					const newLastPoint = this.app
						.getPointInShapeSpace(shape, this.pagePointWhereCurrentSegmentChanged)
						.toFixed()
						.toJson()

					if (prevSegment.type === 'straight') {
						this.currentLineLength += Vec2d.Dist(prevLastPoint, newLastPoint)

						newSegment = {
							type: 'straight',
							points: [{ ...prevLastPoint }, newLastPoint],
						}

						const transform = this.app.getPageTransform(shape)!

						this.pagePointWhereCurrentSegmentChanged = Matrix2d.applyToPoint(
							transform,
							prevLastPoint
						)
					} else {
						newSegment = {
							type: 'straight',
							points: [newLastPoint, newPoint],
						}
					}

					this.app.updateShapes(
						[
							{
								id,
								type: 'draw',
								props: {
									segments: [...segments, newSegment],
									isClosed: this.getIsClosed(segments, size),
								},
							},
						],
						true
					)
				}
				break
			}
			case 'starting_free': {
				const { pagePointWhereNextSegmentChanged } = this

				if (pagePointWhereNextSegmentChanged === null) {
					throw Error('We should have a point where the segment changed')
				}

				const hasMovedFarEnough =
					Vec2d.Dist(pagePointWhereNextSegmentChanged, inputs.currentPagePoint) > DRAG_DISTANCE

				// Find the distance from where the pointer was when shift was released and
				// where it is now; if it's far enough away, then update the page point where
				// the current segment changed (to match the pagepoint where next segment changed)
				// and set the pagepoint where next segment changed to null.
				if (hasMovedFarEnough) {
					this.pagePointWhereCurrentSegmentChanged = this.pagePointWhereNextSegmentChanged!.clone()
					this.pagePointWhereNextSegmentChanged = null

					// Set the new mode
					this.segmentMode = 'free'

					const newSegments = segments.slice()
					const prevStraightSegment = newSegments[newSegments.length - 1]
					const prevPoint = last(prevStraightSegment.points)

					if (!prevPoint) {
						throw Error('No previous point!')
					}

					// Create the new free segment and interpolate the points between where the last line
					// ended and where the pointer is now
					const newFreeSegment: TLDrawShapeSegment = {
						type: 'free',
						points: [
							...Vec2d.PointsBetween(prevPoint, newPoint, 6).map((p) => p.toFixed().toJson()),
						],
					}

					const finalSegments = [...newSegments, newFreeSegment]
					this.currentLineLength = this.getLineLength(finalSegments)

					this.app.updateShapes(
						[
							{
								id,
								type: 'draw',
								props: {
									segments: finalSegments,
									isClosed: this.getIsClosed(finalSegments, size),
								},
							},
						],
						true
					)
				}

				break
			}
			case 'straight': {
				const newSegments = segments.slice()
				const newSegment = newSegments[newSegments.length - 1]

				const { pagePointWhereCurrentSegmentChanged } = this
				const { currentPagePoint, ctrlKey } = this.app.inputs

				if (!pagePointWhereCurrentSegmentChanged)
					throw Error('We should have a point where the segment changed')

				let pagePoint: Vec2dModel
				let shouldSnapToAngle = false

				if (this.didJustShiftClickToExtendPreviousShapeLine) {
					if (this.app.inputs.isDragging) {
						// If we've just shift clicked to extend a line, only snap once we've started dragging
						shouldSnapToAngle = !ctrlKey
						this.didJustShiftClickToExtendPreviousShapeLine = false
					} else {
						// noop
					}
				} else {
					// If we're not shift clicking to extend a line, but we're holding shift, then we should snap
					shouldSnapToAngle = !ctrlKey // don't snap angle while snapping line
				}

				let newPoint = this.app.getPointInShapeSpace(shape, currentPagePoint).toFixed().toJson()
				let didSnap = false
				let snapSegment: TLDrawShapeSegment | undefined = undefined

				const shouldSnap = this.app.userDocumentSettings.isSnapMode ? !ctrlKey : ctrlKey

				if (shouldSnap) {
					if (newSegments.length > 2) {
						let nearestPoint: Vec2dModel | undefined = undefined
						let minDistance = 8 / this.app.zoomLevel

						// Don't try to snap to the last two segments
						for (let i = 0, n = segments.length - 2; i < n; i++) {
							const segment = segments[i]
							if (!segment) break
							if (segment.type === 'free') continue

							const first = segment.points[0]
							const lastPoint = last(segment.points)
							if (!(first && lastPoint)) continue

							// Snap to the nearest point on the segment, if it's closer than the previous snapped point
							const nearestPointOnSegment = Vec2d.NearestPointOnLineSegment(
								first,
								lastPoint,
								newPoint
							)
							const distance = Vec2d.Dist(nearestPointOnSegment, newPoint)

							if (distance < minDistance) {
								nearestPoint = nearestPointOnSegment.toFixed().toJson()
								minDistance = distance
								snapSegment = segment
								break
							}
						}

						if (nearestPoint) {
							didSnap = true
							newPoint = nearestPoint
						}
					}
				}

				if (didSnap && snapSegment) {
					const transform = this.app.getPageTransform(shape)!
					const first = snapSegment.points[0]
					const lastPoint = last(snapSegment.points)
					if (!lastPoint) throw Error('Expected a last point!')

					const A = Matrix2d.applyToPoint(transform, first)

					const B = Matrix2d.applyToPoint(transform, lastPoint)

					const snappedPoint = Matrix2d.applyToPoint(transform, newPoint)

					this.app.snaps.setLines([
						{
							id: uniqueId(),
							type: 'points',
							points: [A, snappedPoint, B],
						},
					])
				} else {
					this.app.snaps.clear()

					if (shouldSnapToAngle) {
						// Snap line angle to nearest 15 degrees
						const currentAngle = Vec2d.Angle(pagePointWhereCurrentSegmentChanged, currentPagePoint)
						const snappedAngle = snapAngle(currentAngle, 24)
						const angleDiff = snappedAngle - currentAngle

						pagePoint = Vec2d.RotWith(
							currentPagePoint,
							pagePointWhereCurrentSegmentChanged,
							angleDiff
						)
					} else {
						pagePoint = currentPagePoint
					}

					newPoint = this.app.getPointInShapeSpace(shape, pagePoint).toFixed().toJson()
				}

				// If the previous segment is a one point free shape and is the first segment of the line,
				// then the user just did a click-and-immediately-press-shift to create a new straight line
				// without continuing the previous line. In this case, we want to remove the previous segment.

				this.currentLineLength += Vec2d.Dist(newSegment.points[0], newPoint)

				newSegments[newSegments.length - 1] = {
					...newSegment,
					type: 'straight',
					points: [newSegment.points[0], newPoint],
				}

				this.app.updateShapes(
					[
						{
							id,
							type: 'draw',
							props: {
								segments: newSegments,
								isClosed: this.getIsClosed(segments, size),
							},
						},
					],
					true
				)

				break
			}
			case 'free': {
				const newSegments = segments.slice()
				const newSegment = newSegments[newSegments.length - 1]
				const newPoints = [...newSegment.points]

				if (newPoints.length && this.mergeNextPoint) {
					const { z } = newPoints[newPoints.length - 1]
					newPoints[newPoints.length - 1] = {
						x: newPoint.x,
						y: newPoint.y,
						z: z ? Math.max(z, newPoint.z) : newPoint.z,
					}
					// Note: we could recompute the line length here, but it's not really necessary
					// this.currentLineLength = this.getLineLength(newSegments)
				} else {
					this.currentLineLength += Vec2d.Dist(newPoints[newPoints.length - 1], newPoint)
					newPoints.push(newPoint)
				}

				newSegments[newSegments.length - 1] = {
					...newSegment,
					points: newPoints,
				}

				this.currentLineLength = this.getLineLength(newSegments)

				this.app.updateShapes(
					[
						{
							id,
							type: 'draw',
							props: {
								segments: newSegments,
								isClosed: this.getIsClosed(segments, size),
							},
						},
					],
					true
				)

				// Set a maximum length for the lines array; after 200 points, complete the line.
				if (newPoints.length > 500) {
					this.app.updateShapes([{ id, type: 'draw', props: { isComplete: true } }])

					const { currentPagePoint } = this.app.inputs

					const newShapeId = this.app.createShapeId()

					this.app.createShapes([
						{
							id: newShapeId,
							type: 'draw',
							x: currentPagePoint.x,
							y: currentPagePoint.y,
							props: {
								isPen: this.isPen,
								segments: [
									{
										type: 'free',
										points: [{ x: 0, y: 0, z: this.isPen ? +(z! * 1.25).toFixed() : 0.5 }],
									},
								],
							},
						},
					])

					this.initialShape = structuredClone(this.app.getShapeById<TLDrawShape>(newShapeId)!)
					this.mergeNextPoint = false
					this.lastRecordedPoint = this.app.inputs.currentPagePoint.clone()
					this.currentLineLength = 0
				}

				break
			}
		}
	}

	private getLineLength(segments: TLDrawShapeSegment[]) {
		let length = 0

		for (const segment of segments) {
			for (let i = 0; i < segment.points.length - 1; i++) {
				const A = segment.points[i]
				const B = segment.points[i + 1]
				length += Vec2d.Sub(B, A).len2()
			}
		}

		return Math.sqrt(length)
	}

	override onPointerUp: TLEventHandlers['onPointerUp'] = () => {
		this.complete()
	}

	override onCancel: TLEventHandlers['onCancel'] = () => {
		this.cancel()
	}

	override onComplete: TLEventHandlers['onComplete'] = () => {
		this.complete()
	}

	override onInterrupt: TLEventHandlers['onInterrupt'] = () => {
		if (this.app.inputs.isDragging) {
			return
		}

		this.app.bail()
		this.cancel()
	}

	complete() {
		// If we weren't focused when the drawing shape started, and if
		// we haven't dragged far enough to start dragging, then don't do
		// anything here. Most likely we clicked back into the canvas from
		// a menu or other UI element.
		if (!this.canDraw) {
			this.cancel()
			return
		}

		const { initialShape } = this
		if (!initialShape) return
		this.app.updateShapes([
			{ id: initialShape.id, type: initialShape.type, props: { isComplete: true } },
		])

		this.parent.transition('idle', {})
	}

	cancel() {
		this.parent.transition('idle', this.info)
	}
}
