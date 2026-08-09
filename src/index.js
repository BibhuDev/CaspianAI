import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db/client.js';
import { initCaspianListener } from './services/caspian.js';
import { startExtractionWorker } from './workers/extractionWorker.js';

const app = createApp();

const server = app.listen(config.port, async () => {
  console.log(`ThreadGraph Server listening on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Base URL: http://localhost:${config.port}`);

  // Initialize Caspian communication layer
  await initCaspianListener();

  // Start background extraction worker (in development, running embedded with server)
  startExtractionWorker();
});

// Graceful shutdown handling
async function shutdown() {
  console.log('\n[ThreadGraph] Gracefully shutting down...');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('[ThreadGraph] Database disconnected. Exit complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
