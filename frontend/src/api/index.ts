import { httpApi, type Api } from './client'
import { mockApi } from './mock'

export const USE_MOCK = import.meta.env.VITE_MOCK !== '0'
export const api: Api = USE_MOCK ? mockApi : httpApi
export * from './types'
export type { ConnStatus } from './client'
