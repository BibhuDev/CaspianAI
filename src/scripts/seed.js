import { prisma } from '../db/client.js';
import { handleCaspianIncomingMessage } from '../services/caspian.js';

async function seed() {
  console.log('--- Seeding ThreadGraph with Sample Data ---');

  const sampleMessages = [
    {
      channel: 'SLACK',
      platform: 'SLACK',
      sender: 'alex@company.com',
      thread_id: 'slack-thread-789',
      content: 'We agreed to use Caspian SDK for multi-channel message ingestion into PostgreSQL with pgvector.',
      metadata: { author: 'Alex Chen', channel_name: '#architecture' },
    },
    {
      channel: 'EMAIL',
      platform: 'EMAIL',
      sender: 'sarah@company.com',
      subject: 'Commitment on Graph Visualizer',
      content: 'I will finish building the React Flow conversation graph visualizer and link it to PR #88 by next Monday.',
      metadata: { author: 'Sarah Lin', priority: 'high' },
    },
    {
      channel: 'SLACK',
      platform: 'SLACK',
      sender: 'dev-bot',
      thread_id: 'slack-thread-990',
      content: 'GitHub PR #88 opened: "feat(graph): add provenance evidence inspector" by @sarahlin. Implements task "Graph UI".',
      metadata: { pr_number: 88, repo: 'TryCaspian/caspian-sdk' },
    },
  ];

  for (const msg of sampleMessages) {
    const raw = await handleCaspianIncomingMessage(msg);
    console.log(`Created RawMessage [${raw.platform}]: ${raw.id}`);
  }

  console.log('\n✅ Seed data enqueued for background extraction!');
  await prisma.$disconnect();
}

seed().catch(async (err) => {
  console.error('Seed failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
