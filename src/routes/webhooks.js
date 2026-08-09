import express from 'express';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { enqueueMessageExtraction } from '../queue/extractionQueue.js';
import { handleCaspianIncomingMessage } from '../services/caspian.js';
import { config } from '../config.js';

const router = express.Router();

/**
 * Validate GitHub Webhook HMAC signature
 */
function verifyGitHubSignature(req) {
  if (!config.github.webhookSecret || config.github.webhookSecret === 'mock-github-webhook-secret') {
    return true; // Bypass signature verification in dev/mock mode
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', config.github.webhookSecret);
  const digest = `sha256=${hmac.update(JSON.stringify(req.body)).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

/**
 * POST /api/webhooks/github
 * Handle GitHub PR, Commit, and Issue webhook events
 */
router.post('/github', async (req, res) => {
  try {
    if (!verifyGitHubSignature(req)) {
      return res.status(401).json({ error: 'Invalid GitHub webhook signature' });
    }

    const event = req.headers['x-github-event'] || 'push';
    const payload = req.body;
    let content = '';
    let externalId = '';

    if (event === 'pull_request') {
      const pr = payload.pull_request;
      const action = payload.action;
      externalId = `pr-${pr.number}`;
      content = `GitHub Pull Request #${pr.number} (${action}): "${pr.title}" by @${pr.user?.login}\n\n` +
        `Description:\n${pr.body || 'No description provided'}\n\n` +
        `URL: ${pr.html_url}\nState: ${pr.state}\nBranch: ${pr.head?.ref} -> ${pr.base?.ref}`;
    } else if (event === 'push') {
      const commits = payload.commits || [];
      const branch = payload.ref;
      externalId = `push-${payload.after || Date.now()}`;
      content = `GitHub Push on ${branch} by @${payload.pusher?.name || payload.sender?.login}:\n\n` +
        commits.map(c => `- Commit ${c.id?.slice(0, 7)}: "${c.message}" by @${c.author?.username || c.author?.name} (${c.url})`).join('\n');
    } else if (event === 'issues') {
      const issue = payload.issue;
      const action = payload.action;
      externalId = `issue-${issue.number}`;
      content = `GitHub Issue #${issue.number} (${action}): "${issue.title}" by @${issue.user?.login}\n\n` +
        `Description:\n${issue.body || 'No description'}\n\nURL: ${issue.html_url}`;
    } else {
      content = `GitHub ${event} event received from repository ${payload.repository?.full_name}`;
      externalId = `gh-${event}-${Date.now()}`;
    }

    console.log(`[GitHub Webhook] Received ${event} event: ${externalId}`);

    // Store RawMessage
    const rawMessage = await prisma.rawMessage.create({
      data: {
        platform: 'GITHUB',
        external_id: externalId,
        content,
        raw_payload: {
          event,
          action: payload.action,
          repository: payload.repository?.full_name,
          sender: payload.sender?.login,
          payload,
        },
        processed: false,
      },
    });

    // Enqueue extraction job
    await enqueueMessageExtraction(rawMessage.id, {
      platform: 'GITHUB',
      event,
      externalId,
    });

    return res.status(200).json({
      success: true,
      messageId: rawMessage.id,
      event,
      externalId,
    });
  } catch (err) {
    console.error('[GitHub Webhook] Error processing event:', err);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * POST /api/webhooks/caspian
 * Handle incoming Caspian events (Email, Slack)
 */
router.post('/caspian', async (req, res) => {
  try {
    const messagePayload = req.body;
    const rawMessage = await handleCaspianIncomingMessage(messagePayload);

    return res.status(200).json({
      success: true,
      messageId: rawMessage.id,
      platform: rawMessage.platform,
    });
  } catch (err) {
    console.error('[Caspian Webhook] Error processing message:', err);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

export default router;
