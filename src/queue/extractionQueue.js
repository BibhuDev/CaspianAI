import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

export const EXTRACTION_QUEUE_NAME = 'message-extraction-queue';

export const extractionQueue = new Queue(EXTRACTION_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/**
 * Enqueue a RawMessage for LLM entity and provenance graph extraction
 * @param {string} rawMessageId - UUID of the RawMessage
 * @param {Object} [extraContext={}] - Optional additional context
 */
export async function enqueueMessageExtraction(rawMessageId, extraContext = {}) {
  try {
    const job = await extractionQueue.add(
      'extract-entities',
      {
        rawMessageId,
        enqueuedAt: new Date().toISOString(),
        ...extraContext,
      },
      {
        jobId: `msg-${rawMessageId}`, // Prevent duplicate concurrent extraction
      }
    );
    console.log(`[BullMQ] Enqueued extraction job ${job.id} for RawMessage ${rawMessageId}`);
    return job;
  } catch (err) {
    console.error(`[BullMQ] Failed to enqueue extraction for ${rawMessageId}:`, err.message);
    throw err;
  }
}
