import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createSpeechmaticsJWT } from '@speechmatics/auth'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    // server: {
    //   proxy: {
    //     '/api/call': 'http://localhost:3000',
    //   },
    // },
    server: {
      proxy: {
        // keep existing call endpoint proxied to backend
        '/api/call': 'http://localhost:3000',
    
        // NEW: proxy caretaker endpoints to backend
        '/api/caretaker': 'http://localhost:3000',
      },
    },
    plugins: [
      react(),
      {
        name: 'api-endpoints',
        configureServer(server) {
          // GET /api/speechmatics/jwt — generate a short-lived RT token
          server.middlewares.use('/api/speechmatics/jwt', (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Method not allowed' }))
              return
            }

            const apiKey = env.SPEECHMATICS_API_KEY
            if (!apiKey) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'SPEECHMATICS_API_KEY not configured' }))
              return
            }

            createSpeechmaticsJWT({ type: 'rt', apiKey, ttl: 60 })
              .then((jwt) => {
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ jwt }))
              })
              .catch((err) => {
                console.error('[api/speechmatics/jwt] Error:', err)
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Failed to create JWT' }))
              })
          })

          // POST /api/voice — receive transcript text
          server.middlewares.use('/api/voice', (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.end(JSON.stringify({ error: 'Method not allowed' }))
              return
            }

            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                  transcript: string
                }
                const { transcript } = body
                console.log(
                  `[api/voice] Received transcript — ${transcript.length} chars`,
                )
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, length: transcript.length }))
              } catch {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Invalid JSON body' }))
              }
            })
          })
        },
      },
    ],
  }
})
