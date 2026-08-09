import express from 'express';
import { prisma, findSimilarNodes } from '../db/client.js';
import { generateEmbedding } from '../services/llmExtractor.js';
import { enqueueMessageExtraction } from '../queue/extractionQueue.js';

const router = express.Router();

/**
 * GET /api/graph/stats
 * Overview metrics of the conversation graph
 */
router.get('/stats', async (req, res) => {
  try {
    const [totalNodes, totalEdges, totalRawMessages, unprocessedCount, nodesByType] = await Promise.all([
      prisma.node.count(),
      prisma.edge.count(),
      prisma.rawMessage.count(),
      prisma.rawMessage.count({ where: { processed: false } }),
      prisma.node.groupBy({
        by: ['type'],
        _count: { id: true },
      }),
    ]);

    return res.json({
      success: true,
      stats: {
        totalNodes,
        totalEdges,
        totalRawMessages,
        unprocessedRawMessages: unprocessedCount,
        nodesByType: nodesByType.reduce((acc, curr) => {
          acc[curr.type] = curr._count.id;
          return acc;
        }, {}),
      },
    });
  } catch (err) {
    console.error('[Graph API] Error fetching stats:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/graph/nodes
 * Query and filter nodes in the graph
 */
router.get('/nodes', async (req, res) => {
  try {
    const { type, search, limit = 50, offset = 0 } = req.query;

    const where = {};
    if (type) {
      where.type = type.toUpperCase();
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { summary: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [nodes, total] = await Promise.all([
      prisma.node.findMany({
        where,
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10),
        orderBy: { created_at: 'desc' },
        include: {
          _count: {
            select: {
              outgoingEdges: true,
              incomingEdges: true,
            },
          },
        },
      }),
      prisma.node.count({ where }),
    ]);

    return res.json({
      success: true,
      data: nodes,
      pagination: {
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      },
    });
  } catch (err) {
    console.error('[Graph API] Error querying nodes:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/graph/nodes/:id
 * Get single node with its 1-hop connected edges and provenance evidence
 */
router.get('/nodes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const node = await prisma.node.findUnique({
      where: { id },
      include: {
        outgoingEdges: {
          include: {
            targetNode: true,
          },
        },
        incomingEdges: {
          include: {
            sourceNode: true,
          },
        },
      },
    });

    if (!node) {
      return res.status(404).json({ error: `Node ${id} not found` });
    }

    return res.json({
      success: true,
      data: node,
    });
  } catch (err) {
    console.error('[Graph API] Error fetching node details:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/graph/search
 * Semantic vector similarity search over conversation graph nodes
 */
router.post('/search', async (req, res) => {
  try {
    const { query, types, limit = 10, minSimilarity = 0.4 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query string is required' });
    }

    // 1. Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // 2. Perform vector search in pgvector
    const similarNodes = await findSimilarNodes({
      embedding: queryEmbedding,
      limit: parseInt(limit, 10),
      minSimilarity: parseFloat(minSimilarity),
      types: Array.isArray(types) ? types : undefined,
    });

    return res.json({
      success: true,
      query,
      results: similarNodes,
    });
  } catch (err) {
    console.error('[Graph API] Error during vector search:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/messages/simulate
 * Developer endpoint to simulate incoming conversation messages and test graph extraction
 */
router.post('/messages/simulate', async (req, res) => {
  try {
    const { platform = 'SLACK', content, external_id, raw_payload = {} } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const rawMessage = await prisma.rawMessage.create({
      data: {
        platform: platform.toUpperCase(),
        external_id: external_id || `sim-${Date.now()}`,
        content,
        raw_payload,
        processed: false,
      },
    });

    // Enqueue extraction job
    await enqueueMessageExtraction(rawMessage.id, {
      simulated: true,
    });

    return res.status(201).json({
      success: true,
      message: 'Simulated message saved and enqueued for extraction',
      rawMessage,
    });
  } catch (err) {
    console.error('[Simulator] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
