// REST client for the SiteMind FastAPI backend (see docs/CONTRACT.md). In VITE_MOCK=1 mode
// every call is served by the in-browser mock in src/mock/server.ts.
import type { ApprovalDecision, CreateRunRequest, Health, RunSnapshot, SpecialistSpec } from './types'
import { mockApi } from './mock/server'

export const IS_MOCK = import.meta.env.VITE_MOCK === '1' || new URLSearchParams(window.location.search).has('mock')

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (body.detail) msg = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  const ct = res.headers.get('content-type') ?? ''
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T
}

const realApi = {
  health: () => req<Health>('/health'),
  registry: () => req<SpecialistSpec[]>('/registry'),
  defaults: () => req<CreateRunRequest>('/demo/defaults'),
  listRuns: () => req<RunSnapshot[]>('/runs'),
  createRun: (body: CreateRunRequest) => req<RunSnapshot>('/runs', { method: 'POST', json: body }),
  getRun: (id: string) => req<RunSnapshot>(`/runs/${encodeURIComponent(id)}`),
  kill: (id: string) => req<RunSnapshot>(`/runs/${encodeURIComponent(id)}/kill`, { method: 'POST' }),
  resume: (id: string) => req<RunSnapshot>(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  decide: (id: string, approvalId: string, d: ApprovalDecision) =>
    req<RunSnapshot>(`/runs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', json: d }),
  poMarkdown: (id: string) => req<string>(`/runs/${encodeURIComponent(id)}/po.md`, { headers: { Accept: 'text/markdown' } }),
}

export type Api = typeof realApi

export const api: Api = IS_MOCK ? mockApi : realApi
