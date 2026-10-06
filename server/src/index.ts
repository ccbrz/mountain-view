import express from 'express'
import cors from 'cors'
import path from 'path'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import authRoutes from './routes/auth'
import roleRoutes from './routes/roles'
import novelRoutes from './routes/novels'
import novelGeneratorRoutes from './routes/novel-generator'
import llmConfigRoutes from './routes/llm-configs'
import { initSchema } from './schema'
import { initLogStore } from './llm/logstore'
import { initVectorStore } from './llm/vectorstore'
import { isProduction, getAllowedOrigins } from './config'

const app = express()
const PORT = process.env.PORT || 3001

app.use(helmet())

const allowedOrigins = getAllowedOrigins()
app.use(cors({
  // 生产环境未配置 ALLOWED_ORIGINS 时拒绝跨域，而不是放通全部
  origin: allowedOrigins.length > 0 ? allowedOrigins : !isProduction(),
  credentials: true,
}))

app.use(express.json())

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: '登录尝试过于频繁，请 15 分钟后重试' },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/api/auth/login', loginLimiter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth', authRoutes)
app.use('/api/roles', roleRoutes)
app.use('/api/novels', novelRoutes)
app.use('/api/novels', novelGeneratorRoutes)
app.use('/api/llm-configs', llmConfigRoutes)

if (isProduction()) {
  app.use(express.static(path.join(__dirname, '../../client/dist')))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'))
  })
}

initSchema()
initLogStore()
initVectorStore()

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
