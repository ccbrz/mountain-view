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

app.use(cors({
  origin: getAllowedOrigins().length > 0 ? getAllowedOrigins() : true,
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
