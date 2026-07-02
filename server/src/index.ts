import express from 'express'
import cors from 'cors'
import path from 'path'
import authRoutes from './routes/auth'
import roleRoutes from './routes/roles'
import novelRoutes from './routes/novels'
import novelGeneratorRoutes from './routes/novel-generator'
import llmConfigRoutes from './routes/llm-configs'
import { initSchema } from './schema'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.use('/api/auth', authRoutes)
app.use('/api/roles', roleRoutes)
app.use('/api/novels', novelRoutes)
app.use('/api/novels', novelGeneratorRoutes)
app.use('/api/llm-configs', llmConfigRoutes)

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'))
  })
}

initSchema()

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
