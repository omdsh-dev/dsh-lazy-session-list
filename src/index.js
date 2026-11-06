import { symbols } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-lazy-session-list'
export const inject = ['sessionController']

export const Config = Schema.object({
  listProjectionKeys: Schema.array(Schema.string()).default([
    'title', 'sessionListMetadata', 'subagentCatalog', 'agentPreset',
  ]).description('Complete allowlist of projection keys retained in session/list; all other keys load per session.'),
})

/** Keep list indexes at the list boundary, after native authorization. */
export function apply(ctx, config) {
  const controller = ctx.sessionController[symbols.original] ?? ctx.sessionController
  const retainedKeys = new Set(config.listProjectionKeys)

  ctx.effect(() => {
    const descriptor = Object.getOwnPropertyDescriptor(controller, 'list')
    const original = controller.list
    let active = true

    async function list(...args) {
      // Cordis supplies the caller's invocation through this receiver. Binding the
      // original to the plugin or raw instance would lose per-session access checks.
      const result = await Reflect.apply(original, this, args)
      if (!active) return result
      return {
        ...result,
        items: result.items.map(item => {
          const projections = item.projections
          if (projections === undefined) return item
          const keys = Object.keys(projections.values)
          if (keys.every(key => retainedKeys.has(key))) return item
          const values = { ...projections.values }
          for (const key of keys) if (!retainedKeys.has(key)) delete values[key]
          // Omit entire keys so a full baseline at the same seq can still seed them.
          return { ...item, projections: { ...projections, values } }
        }),
      }
    }

    Object.defineProperty(controller, 'list', { configurable: true, writable: true, value: list })
    return () => {
      // A later wrapper may retain this function, or restore it after disposal.
      // Disable it first, including calls already awaiting the native list.
      active = false
      if (Object.getOwnPropertyDescriptor(controller, 'list')?.value !== list) return
      if (descriptor === undefined) delete controller.list
      else Object.defineProperty(controller, 'list', descriptor)
    }
  }, 'dsh-lazy-session-list: defer non-index projections')
}
