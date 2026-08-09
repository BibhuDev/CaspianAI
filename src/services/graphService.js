import { prisma, upsertNodeWithEmbedding } from '../db/client.js';
import { generateEmbedding } from './llmExtractor.js';

/**
 * Ingest extracted nodes and edges from a RawMessage into PostgreSQL
 * @param {Object} params
 * @param {string} params.rawMessageId - ID of RawMessage record
 * @param {Array} params.extractedNodes - Array of node objects with temp_id
 * @param {Array} params.extractedEdges - Array of edge objects with source_temp_id and target_temp_id
 * @returns {Promise<{ createdNodes: number, createdEdges: number }>}
 */
export async function ingestExtractionResult({ rawMessageId, extractedNodes, extractedEdges }) {
  const tempIdToDbId = new Map();

  // 1. Process and upsert each Node
  for (const node of extractedNodes) {
    let existingNode = null;

    // Deduplication logic
    if (node.type === 'PERSON') {
      // Find person by matching title (name)
      existingNode = await prisma.node.findFirst({
        where: {
          type: 'PERSON',
          title: { equals: node.title, mode: 'insensitive' },
        },
      });
    } else if (node.type.startsWith('GITHUB_') && node.metadata?.external_id) {
      // Match GitHub entities by external_id or url
      existingNode = await prisma.node.findFirst({
        where: {
          type: node.type,
          metadata: {
            path: ['external_id'],
            equals: node.metadata.external_id,
          },
        },
      });
    } else if (node.type === 'PROJECT') {
      existingNode = await prisma.node.findFirst({
        where: {
          type: 'PROJECT',
          title: { equals: node.title, mode: 'insensitive' },
        },
      });
    }

    if (existingNode) {
      tempIdToDbId.set(node.temp_id, existingNode.id);
      console.log(`[GraphService] Deduplicated node [${node.type}] "${node.title}" -> ${existingNode.id}`);
    } else {
      // Generate embedding for node content
      const textToEmbed = `${node.title}: ${node.summary}`;
      const embedding = await generateEmbedding(textToEmbed);

      const createdNode = await upsertNodeWithEmbedding({
        type: node.type,
        title: node.title,
        summary: node.summary,
        metadata: {
          ...node.metadata,
          raw_message_id: rawMessageId,
        },
        embedding,
      });

      tempIdToDbId.set(node.temp_id, createdNode.id);
      console.log(`[GraphService] Created Node [${node.type}] "${node.title}" -> ${createdNode.id}`);
    }
  }

  // 2. Create Edges with provenance metadata
  let createdEdgesCount = 0;
  for (const edge of extractedEdges) {
    const sourceDbId = tempIdToDbId.get(edge.source_temp_id);
    const targetDbId = tempIdToDbId.get(edge.target_temp_id);

    if (!sourceDbId || !targetDbId) {
      console.warn(`[GraphService] Skipping edge: missing source (${edge.source_temp_id}) or target (${edge.target_temp_id})`);
      continue;
    }

    // Check if duplicate edge exists
    const existingEdge = await prisma.edge.findFirst({
      where: {
        source_node_id: sourceDbId,
        target_node_id: targetDbId,
        relationship_type: edge.relationship_type,
      },
    });

    if (!existingEdge) {
      await prisma.edge.create({
        data: {
          source_node_id: sourceDbId,
          target_node_id: targetDbId,
          relationship_type: edge.relationship_type,
          source_metadata: {
            evidence_snippet: edge.evidence_snippet,
            raw_message_id: rawMessageId,
            ...(edge.source_metadata || {}),
          },
        },
      });
      createdEdgesCount++;
    }
  }

  // 3. Mark RawMessage as processed
  await prisma.rawMessage.update({
    where: { id: rawMessageId },
    data: {
      processed: true,
      processed_at: new Date(),
    },
  });

  console.log(`[GraphService] Finished ingestion for RawMessage ${rawMessageId}: ${extractedNodes.length} nodes processed, ${createdEdgesCount} edges created.`);
  return {
    createdNodes: extractedNodes.length,
    createdEdges: createdEdgesCount,
  };
}
