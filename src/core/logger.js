import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
    }
  }),
  // Ne jamais laisser fuiter un secret dans les logs
  redact: {
    paths: ['*.apiKey', '*.key', '*.uri', '*.password', 'req.headers.authorization'],
    censor: '[masqué]'
  }
})

/** Logger enfant étiqueté par composant : logger.child({ mod: 'discovery' }) */
export const mod = name => logger.child({ mod: name })
