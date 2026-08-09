import { extractEntitiesAndProvenance, generateEmbedding } from '../services/llmExtractor.js';

async function runTest() {
  console.log('--- Testing ThreadGraph Extraction Engine ---');

  const sampleSlackMessage = {
    id: 'msg-sample-001',
    platform: 'SLACK',
    external_id: 'slack-thread-101',
    created_at: new Date().toISOString(),
    raw_payload: {
      channel: '#eng-backend',
      author: 'alex',
    },
    content: `
Alex: Hey team, in today's sync we decided to switch our vector database index from HNSW to IVFFlat for better memory efficiency.
Sarah: Sounds good. I will implement the migration in PR #42 by this Friday.
Alex: Great! Note that this blocks task "Deploy Graph v2 to Staging".
`,
  };

  console.log('\nInput Conversation:');
  console.log(sampleSlackMessage.content);

  console.log('\nExtracting Entities and Directional Provenance-backed Edges...');
  const extraction = await extractEntitiesAndProvenance(sampleSlackMessage);

  console.log('\n--- Extracted Nodes ---');
  console.dir(extraction.nodes, { depth: null });

  console.log('\n--- Extracted Edges (with Evidence Snippets) ---');
  console.dir(extraction.edges, { depth: null });

  console.log('\n--- Generating Vector Embedding ---');
  const sampleEmbedding = await generateEmbedding('Switch vector database index to IVFFlat');
  console.log(`Generated embedding with ${sampleEmbedding.length} dimensions. First 5 dims:`, sampleEmbedding.slice(0, 5));

  console.log('\n✅ ThreadGraph Extraction Test Completed Successfully!');
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
