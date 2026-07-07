function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[FATAL] 环境变量 ${name} 未设置，服务无法启动。`)
    process.exit(1)
  }
  return value
}

export const JWT_SECRET = requireEnv('JWT_SECRET')

export function isProduction() {
  return process.env.NODE_ENV === 'production'
}

export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS
  if (raw) return raw.split(',').map((s) => s.trim())
  if (isProduction()) return [] 
  return ['http://localhost:5173', 'http://localhost:3001']
}
