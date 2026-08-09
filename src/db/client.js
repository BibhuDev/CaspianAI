import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * Format a JavaScript array of numbers into a Postgres vector literal string "[0.123, 0.456, ...]"
 * @param {number[]} vector 
 * @returns {string}
 */
export function formatVector(vector) {
  if (!vector || !Array.isArray(vector)) return null;
  return `[${vector.join(',')}]`;
}

/**
 * Perform cosine distance vector similarity search on Node embeddings
 * Cosine distance operator is `<=>`. Cosine similarity is `1 - distance`.
 * 
 * @param {Object} options
 * @param {number[]} options.embedding - Query vector embedding (1536 dims)
 * @param {number} [options.limit=10] - Maximum number of results
 * @param {number} [options.minSimilarity=0.0] - Minimum cosine similarity threshold (0.0 to 1.0)
 * @param {string[]} [options.types] - Filter by NodeType (e.g. ['DECISION', 'TASK'])
 * @returns {Promise<Array<Object>>}
 */
export async function findSimilarNodes({ embedding, limit = 10, minSimilarity = 0.5, types = [] }) {
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Valid vector embedding array is required for similarity search');
  }

  const vectorString = formatVector(embedding);
  const typeFilter = types && types.length > 0 
    ? `AND type::text IN (${types.map(t => `'${t}'`).join(',')})`
    : '';

  // Use raw SQL for pgvector cosine distance calculation
  const query = `
    SELECT 
      id,
      type,
      title,
      summary,
      metadata,
      created_at,
      updated_at,
      1 - (embedding <=> '${vectorString}'::vector) AS similarity
    FROM nodes
    WHERE embedding IS NOT NULL
      ${typeFilter}
      AND (1 - (embedding <=> '${vectorString}'::vector)) >= ${minSimilarity}
    ORDER BY embedding <=> '${vectorString}'::vector ASC
    LIMIT ${limit};
  `;

  const results = await prisma.$queryRawUnsafe(query);
  return results;
}

/**
 * Save or update a node with its vector embedding
 * @param {Object} nodeData
 * @returns {Promise<Object>}
 */
export async function upsertNodeWithEmbedding(nodeData) {
  const { id, type, title, summary, metadata = {}, embedding } = nodeData;

  const vectorString = embedding && Array.isArray(embedding) ? formatVector(embedding) : null;
  const metadataJson = JSON.stringify(metadata);

  if (id) {
    // Update existing node
    if (vectorString) {
      const [updated] = await prisma.$queryRawUnsafe(`
        UPDATE nodes
        SET 
          type = '${type}'::"NodeType",
          title = $1,
          summary = $2,
          metadata = $3::jsonb,
          embedding = '${vectorString}'::vector,
          updated_at = NOW()
        WHERE id = '${id}'::uuid
        RETURNING id, type, title, summary, metadata, created_at, updated_at;
      `, title, summary, metadataJson);
      return updated;
    } else {
      return await prisma.node.update({
        where: { id },
        data: { type, title, summary, metadata },
      });
    }
  } else {
    // Insert new node
    if (vectorString) {
      const [created] = await prisma.$queryRawUnsafe(`
        INSERT INTO nodes (id, type, title, summary, metadata, embedding, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          '${type}'::"NodeType",
          $1,
          $2,
          $3::jsonb,
          '${vectorString}'::vector,
          NOW(),
          NOW()
        )
        RETURNING id, type, title, summary, metadata, created_at, updated_at;
      `, title, summary, metadataJson);
      return created;
    } else {
      return await prisma.node.create({
        data: { type, title, summary, metadata },
      });
    }
  }
}
