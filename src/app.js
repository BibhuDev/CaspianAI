import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import webhooksRouter from './routes/webhooks.js';
import graphRouter from './routes/graph.js';

export function createApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(morgan('dev'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Root & Health checks
  app.get('/', (req, res) => {
    res.json({
      name: 'ThreadGraph API',
      version: '1.0.0',
      description: 'AI Conversation Intelligence Graph for Engineering Teams',
      status: 'operational',
      endpoints: {
        health: '/health',
        graphStats: '/api/graph/stats',
        graphNodes: '/api/graph/nodes',
        vectorSearch: 'POST /api/graph/search',
        simulateMessage: 'POST /api/graph/messages/simulate',
        githubWebhook: 'POST /api/webhooks/github',
        caspianWebhook: 'POST /api/webhooks/caspian',
      },
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API Routes
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/graph', graphRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Global Error handler
  app.use((err, req, res, next) => {
    console.error('[App Error]', err);
    res.status(err.status || 500).json({
      error: err.message || 'Internal Server Error',
    });
  });

  return app;
}
