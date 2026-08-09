import { Worker } from 'bullmq';
import { redisConnection } from '../queue/redis.js';
import { EXTRACTION_QUEUE_NAME } from '../queue/extractionQueue.js';
import { prisma } from '../db/client.js';
import { extractEntitiesAndProvenance } from '../services/llmExtractor.js';
import { ingestExtractionResult } from '../services/graphService.js';

export function startExtractionWorker() {
  console.log(`[BullMQ Worker] Starting extraction worker listening on "${EXTRACTION_QUEUE_NAME}"...`);

  const worker = new Worker(
    EXTRACTION_QUEUE_NAME,
    async (job) => {
      const { rawMessageId } = job.data;
      console.log(`[BullMQ Worker] Processing Job ${job.id} for RawMessage: ${rawMessageId}`);

      const rawMessage = await prisma.rawMessage.findUnique({
        where: { id: rawMessageId },
      });

      if (!rawMessage) {
        throw new Error(`RawMessage with ID ${rawMessageId} not found`);
      }

      if (rawMessage.processed) {
        console.log(`[BullMQ Worker] RawMessage ${rawMessageId} already processed. Skipping.`);
        return { status: 'already_processed' };
      }

      // Step 1: LLM Extraction
      console.log(`[BullMQ Worker] Extracting entities and provenance via LLM for message ${rawMessageId}...`);
      const extraction = await extractEntitiesAndProvenance(rawMessage);
      console.log(`[BullMQ Worker] Extracted ${extraction.nodes.length} nodes and ${extraction.edges.length} edges.`);

      // Step 2: Database Graph Ingestion
      console.log(`[BullMQ Worker] Ingesting graph nodes and edges into PostgreSQL...`);
      const result = await ingestExtractionResult({
        rawMessageId: rawMessage.id,
        extractedNodes: extraction.nodes,
        extractedEdges: extraction.edges,
      });

      return result;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job, returnvalue) => {
    console.log(`[BullMQ Worker] Job ${job.id} completed successfully:`, returnvalue);
  });

  worker.on('failed', (job, err) => {
    console.error(`[BullMQ Worker] Job ${job?.id} failed with error:`, err.message);
  });

  return worker;
}

// Standalone execution support: `node src/workers/extractionWorker.js`
if (process.argv[1] && process.argv[1].endsWith('extractionWorker.js')) {
  startExtractionWorker();
}
