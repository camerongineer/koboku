import { z } from 'zod'

/**
 * Server-side environment only. Never imported from `src/routes` or
 * `src/components`, and no key here carries a `VITE_` prefix, so nothing in
 * this file can reach the browser bundle.
 */
const envSchema = z.object({
  KOBOKU_PROVIDER_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1'),
  KOBOKU_MODEL: z.string().min(1).default('qwen3.8-flash-next-iq3_xxs'),
  KOBOKU_PROVIDER_API_KEY: z.string().min(1),
  KOBOKU_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  KOBOKU_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  /**
   * The directory the jail resolves over. Left as written rather than resolved here: the jail
   * canonicalises the root it is given, so this file stays the place that validates values and
   * not a second place that also knows about paths. Measured 2026-11-08 with node v24.12.0: a
   * relative root becomes `C:\Users\c-em\Repos\koboku\workspace` once `realpathSync` has seen it.
   */
  KOBOKU_WORKSPACE_DIR: z.string().min(1).default('workspace'),
})

export interface HarnessConfig {
  baseUrl: string
  model: string
  apiKey: string
  temperature: number
  maxOutputTokens: number
  /** Canonical or relative — the jail resolves it either way. */
  workspaceDir: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    // Rules and names only. A value may be a secret, so no value is echoed.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`config: environment is not valid (${problems})`)
  }

  return {
    baseUrl: parsed.data.KOBOKU_PROVIDER_BASE_URL,
    model: parsed.data.KOBOKU_MODEL,
    apiKey: parsed.data.KOBOKU_PROVIDER_API_KEY,
    temperature: parsed.data.KOBOKU_TEMPERATURE,
    maxOutputTokens: parsed.data.KOBOKU_MAX_OUTPUT_TOKENS,
    workspaceDir: parsed.data.KOBOKU_WORKSPACE_DIR,
  }
}
