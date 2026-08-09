import { prisma } from '../db/client.js';
import { enqueueMessageExtraction } from '../queue/extractionQueue.js';
import { config } from '../config.js';

/**
 * Normalize and process an incoming message received via Caspian (Email or Slack)
 * @param {Object} messagePayload 
 * @returns {Promise<Object>} The created RawMessage record
 */
export async function handleCaspianIncomingMessage(messagePayload) {
  const {
    id,
    channel,
    platform: rawPlatform,
    content,
    sender,
    subject,
    timestamp,
    thread_id,
    metadata = {},
  } = messagePayload;

  // Determine platform enum: SLACK or EMAIL
  let platform = 'SLACK';
  const platformStr = (rawPlatform || channel || '').toUpperCase();
  if (platformStr.includes('EMAIL') || platformStr.includes('MAIL')) {
    platform = 'EMAIL';
  }

  // Format content body if email includes subject
  const formattedContent = subject 
    ? `Subject: ${subject}\n\n${content || ''}`
    : content || '';

  const externalId = id || thread_id || `caspian-${Date.now()}`;

  console.log(`[Caspian] Ingesting message from [${platform}] ID: ${externalId}`);

  // 1. Store in raw_messages
  const rawMessage = await prisma.rawMessage.create({
    data: {
      platform,
      external_id: externalId,
      content: formattedContent,
      raw_payload: {
        sender,
        channel,
        subject,
        thread_id,
        timestamp: timestamp || new Date().toISOString(),
        ...metadata,
      },
      processed: false,
    },
  });

  // 2. Dispatch to BullMQ for background entity & provenance extraction
  await enqueueMessageExtraction(rawMessage.id, {
    platform,
    externalId,
    sender,
  });

  return rawMessage;
}

/**
 * Initialize Caspian SDK listener
 */
export async function initCaspianListener() {
  if (!config.caspian.apiKey || config.caspian.apiKey === 'mock-caspian-api-key') {
    console.log('[Caspian SDK] Running in development mode with simulated/webhook ingestion ready.');
    return;
  }

  try {
    // Dynamic import to support optional installation or hosted gateway
    const caspianModule = await import('caspian-sdk').catch(() => null);
    if (caspianModule) {
      const CaspianClient = caspianModule.CaspianClient || caspianModule.default || caspianModule.Caspian;
      if (typeof CaspianClient === 'function') {
        const client = new CaspianClient({
          apiKey: config.caspian.apiKey,
          baseUrl: config.caspian.baseUrl,
        });

        if (client.onMessage) {
          client.onMessage(async (message) => {
            console.log('[Caspian SDK] Received live event from Caspian gateway');
            await handleCaspianIncomingMessage(message);
          });
          console.log('[Caspian SDK] Listener registered successfully.');
        }
      }
    }
  } catch (err) {
    console.warn('[Caspian SDK] Could not initialize live listener (falling back to webhook ingestion):', err.message);
  }
}
