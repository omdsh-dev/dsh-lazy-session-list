import { symbols } from '@deepseek-ai/cordis'

export const name = 'dsh-lazy-session-list'
export const inject = ['sessionController']

// Global Insights needs contextTimeline/contextActivity; retain these whole values.
const DEFERRED_KEYS = ['contextHeaders', 'turnOutline', 'better-goal-history']

/** Defer conversation-only projections at the list boundary, after native authorization. */
export function apply(ctx) {
  const controller = ctx.sessionController[symbols.original] ?? ctx.sessionController
  const descriptor = Object.getOwnPropertyDescriptor(controller, 'list')
  const original = controller.list

  async function list(...args) {
    // Cordis supplies the caller's invocation through this receiver. Binding the
    // original to the plugin or raw instance would lose per-session access checks.
    const result = await Reflect.apply(original, this, args)
    return {
      ...result,
      items: result.items.map(item => {
        const projections = item.projections
        if (projections === undefined || !DEFERRED_KEYS.some(key => Object.hasOwn(projections.values, key))) return item
        const values = { ...projections.values }
        for (const key of DEFERRED_KEYS) delete values[key]
        // Omit entire keys so a full baseline at the same seq can still seed them.
        return { ...item, projections: { ...projections, values } }
      }),
    }
  }

  ctx.effect(() => {
    Object.defineProperty(controller, 'list', { configurable: true, writable: true, value: list })
    return () => {
      if (controller.list !== list) return
      if (descriptor === undefined) delete controller.list
      else Object.defineProperty(controller, 'list', descriptor)
    }
  }, 'dsh-lazy-session-list: defer conversation details')
}
