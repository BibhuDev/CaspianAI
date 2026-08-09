import OpenAI from 'openai';
import { config } from '../config.js';

let openaiClient = null;

function getOpenAIClient() {
  if (!openaiClient && config.openai.apiKey && config.openai.apiKey !== 'mock-or-real-openai-api-key') {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }
  return openaiClient;
}

/**
 * Generate 1536-dimensional vector embedding for given text
 * @param {string} text 
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text) {
  const client = getOpenAIClient();
  if (!client) {
    // Generate deterministic normalized mock embedding (1536 dimensions) for testing/local dev
    const mockVector = new Array(1536).fill(0);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    for (let i = 0; i < 1536; i++) {
      mockVector[i] = Math.sin(hash + i) * 0.05;
    }
    return mockVector;
  }

  try {
    const response = await client.embeddings.create({
      model: config.openai.embeddingModel,
      input: text.replace(/\n/g, ' '),
      encoding_format: 'float',
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error('[LLMExtractor] Embedding generation error:', err.message);
    throw err;
  }
}

/**
 * LLM Extraction Prompt & Schema definition
 */
const EXTRACTION_SYSTEM_PROMPT = `
You are ThreadGraph's AI Conversation & Codebase Graph Extraction Engine.
Your job is to analyze incoming developer conversations (Email, Slack, or GitHub discussions/events) and extract structured knowledge graph entities (Nodes) and relationships (Edges).

Primary Differentiator:
EVERY relationship (Edge) MUST preserve its provenance:
- An exact verbatim evidence snippet from the message.
- Clear directional relationship types.

Allowed Node Types:
- PERSON: Team members, contributors, authors, commenters.
- CONVERSATION: The thread, email topic, or discussion itself.
- PROJECT: Software systems, repositories, features, or initiatives.
- DECISION: Architectural decisions, design agreements, consensus reached.
- TASK: Action items, assigned todos, technical backlog items.
- COMMITMENT: Deadlines, promises made by individuals ("I will ship this by Friday").
- GITHUB_PR: Pull requests referenced or discussed.
- GITHUB_COMMIT: Git commits or code changes.
- GITHUB_ISSUE: Issues, bugs, or tickets.

Allowed Relationship Types:
- COMMITTED_TO: (PERSON -> COMMITMENT or PERSON -> TASK)
- DECIDED_IN: (DECISION -> CONVERSATION or DECISION -> PROJECT)
- IMPLEMENTS: (GITHUB_PR -> TASK or GITHUB_PR -> DECISION or GITHUB_COMMIT -> TASK)
- BLOCKS: (TASK -> TASK or GITHUB_ISSUE -> GITHUB_PR)
- PART_OF: (TASK -> PROJECT or CONVERSATION -> PROJECT or DECISION -> PROJECT)
- MENTIONS: (CONVERSATION -> GITHUB_PR or CONVERSATION -> PERSON or CONVERSATION -> GITHUB_ISSUE)
- CREATED_BY: (TASK -> PERSON or DECISION -> PERSON or GITHUB_PR -> PERSON or GITHUB_COMMIT -> PERSON)

Output format must strictly be JSON adhering to the provided schema.
`;

const EXTRACTION_SCHEMA = {
  name: "threadgraph_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      nodes: {
        type: "array",
        description: "Extracted entities from the conversation",
        items: {
          type: "object",
          properties: {
            temp_id: {
              type: "string",
              description: "Unique local identifier for linking edges (e.g. 'node_1', 'node_2')",
            },
            type: {
              type: "string",
              enum: [
                "PERSON",
                "CONVERSATION",
                "PROJECT",
                "DECISION",
                "TASK",
                "COMMITMENT",
                "GITHUB_PR",
                "GITHUB_COMMIT",
                "GITHUB_ISSUE",
              ],
            },
            title: {
              type: "string",
              description: "Clear, concise title or name of the entity",
            },
            summary: {
              type: "string",
              description: "Comprehensive summary and context of the entity",
            },
            metadata: {
              type: "object",
              description: "Arbitrary key-value metadata (author, url, external_id, platform, timestamp, etc.)",
              properties: {
                author: { type: ["string", "null"] },
                platform: { type: ["string", "null"] },
                thread_id: { type: ["string", "null"] },
                url: { type: ["string", "null"] },
                external_id: { type: ["string", "null"] },
                timestamp: { type: ["string", "null"] },
              },
              required: ["author", "platform", "thread_id", "url", "external_id", "timestamp"],
              additionalProperties: false,
            },
          },
          required: ["temp_id", "type", "title", "summary", "metadata"],
          additionalProperties: false,
        },
      },
      edges: {
        type: "array",
        description: "Directional provenance-backed relationships between extracted nodes",
        items: {
          type: "object",
          properties: {
            source_temp_id: {
              type: "string",
              description: "temp_id of the source node",
            },
            target_temp_id: {
              type: "string",
              description: "temp_id of the target node",
            },
            relationship_type: {
              type: "string",
              enum: [
                "COMMITTED_TO",
                "DECIDED_IN",
                "IMPLEMENTS",
                "BLOCKS",
                "PART_OF",
                "MENTIONS",
                "CREATED_BY",
              ],
            },
            evidence_snippet: {
              type: "string",
              description: "Verbatim quote or evidence from the text supporting this relation",
            },
            source_metadata: {
              type: "object",
              properties: {
                message_id: { type: ["string", "null"] },
                author: { type: ["string", "null"] },
                platform: { type: ["string", "null"] },
                timestamp: { type: ["string", "null"] },
              },
              required: ["message_id", "author", "platform", "timestamp"],
              additionalProperties: false,
            },
          },
          required: [
            "source_temp_id",
            "target_temp_id",
            "relationship_type",
            "evidence_snippet",
            "source_metadata",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["nodes", "edges"],
    additionalProperties: false,
  },
};

/**
 * Perform LLM extraction on a RawMessage content
 * @param {Object} rawMessage - The RawMessage database record
 * @returns {Promise<{ nodes: Array, edges: Array }>}
 */
export async function extractEntitiesAndProvenance(rawMessage) {
  const client = getOpenAIClient();

  if (!client) {
    console.warn('[LLMExtractor] OPENAI_API_KEY not configured or in mock mode. Using heuristic extractor.');
    return extractHeuristicEntities(rawMessage);
  }

  const prompt = `
Platform: ${rawMessage.platform}
External ID / Message ID: ${rawMessage.external_id || 'N/A'}
Created At: ${rawMessage.created_at}
Raw Payload Context: ${JSON.stringify(rawMessage.raw_payload || {})}

Message Content:
${rawMessage.content}
`;

  try {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: EXTRACTION_SCHEMA,
      },
      temperature: 0.1,
    });

    const result = JSON.parse(completion.choices[0].message.content);
    return result;
  } catch (err) {
    console.error('[LLMExtractor] Extraction failed:', err);
    throw err;
  }
}

/**
 * Fallback / Test extractor when OpenAI is not configured
 * Useful for automated tests and offline development
 */
export function extractHeuristicEntities(rawMessage) {
  const content = rawMessage.content || '';
  const platform = rawMessage.platform || 'SLACK';
  const externalId = rawMessage.external_id || 'msg-1';
  const timestamp = new Date(rawMessage.created_at || Date.now()).toISOString();

  const nodes = [];
  const edges = [];

  // Conversation Node
  const convNode = {
    temp_id: 'node_conv_1',
    type: 'CONVERSATION',
    title: `${platform} Discussion ${externalId}`,
    summary: content.slice(0, 200),
    metadata: {
      author: 'system',
      platform,
      thread_id: externalId,
      url: null,
      external_id: externalId,
      timestamp,
    },
  };
  nodes.push(convNode);

  // Detect PRs
  const prMatch = content.match(/PR\s*#?(\d+)|pull\/(\d+)/i);
  if (prMatch) {
    const prNumber = prMatch[1] || prMatch[2];
    const prNode = {
      temp_id: 'node_pr_1',
      type: 'GITHUB_PR',
      title: `GitHub PR #${prNumber}`,
      summary: `Pull Request #${prNumber} referenced in ${platform} conversation`,
      metadata: {
        author: null,
        platform: 'GITHUB',
        thread_id: null,
        url: `https://github.com/repo/pull/${prNumber}`,
        external_id: `pr-${prNumber}`,
        timestamp,
      },
    };
    nodes.push(prNode);

    edges.push({
      source_temp_id: convNode.temp_id,
      target_temp_id: prNode.temp_id,
      relationship_type: 'MENTIONS',
      evidence_snippet: prMatch[0],
      source_metadata: {
        message_id: externalId,
        author: platform,
        platform,
        timestamp,
      },
    });
  }

  // Detect Decisions
  if (content.toLowerCase().includes('decided') || content.toLowerCase().includes('decision') || content.toLowerCase().includes('agreed')) {
    const decisionNode = {
      temp_id: 'node_dec_1',
      type: 'DECISION',
      title: 'Architectural Decision',
      summary: content.split('\n')[0],
      metadata: {
        author: 'team',
        platform,
        thread_id: externalId,
        url: null,
        external_id: null,
        timestamp,
      },
    };
    nodes.push(decisionNode);

    edges.push({
      source_temp_id: decisionNode.temp_id,
      target_temp_id: convNode.temp_id,
      relationship_type: 'DECIDED_IN',
      evidence_snippet: content.slice(0, 100),
      source_metadata: {
        message_id: externalId,
        author: 'team',
        platform,
        timestamp,
      },
    });
  }

  return { nodes, edges };
}
