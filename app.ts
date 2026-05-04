import fs from 'node:fs';
import path from 'node:path';
import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import * as dotenv from 'dotenv';
import { SlackUsageMonitor, usageMonitoringMiddleware } from 'services/slack/usage-monitor';
import registerListeners from './listeners';

import { AppConfig } from '@/config';
import { VectorStoreService } from 'services/file-registry/main-service';
import { handleGitHubPushEvent, verifyGitHubSignature } from 'services/github/webhook-handler';
import { getAIProvider, validateCurrentProvider } from 'services/llm';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { SqliteSlackInstallationStore } from 'services/slack/sqlite-installation-store';
import { ensureWorkspaceInitialized } from 'services/slack/workspace-bootstrap';
import { GitHubSyncService } from 'services/sync/github-sync-service';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

dotenv.config({ path: process.env.ENV_FILE || process.env.DOTENV_CONFIG_PATH || '.env' });

function applyQmdCpuOnlyDefaults(): void {
  if (process.env.QMD_FORCE_CPU_ONLY === 'false') {
    return;
  }

  if (!process.env.NODE_LLAMA_CPP_GPU) {
    process.env.NODE_LLAMA_CPP_GPU = 'off';
  }

  if (!process.env.LLAMA_ARG_DEVICE) {
    process.env.LLAMA_ARG_DEVICE = 'none';
  }

  if (!process.env.LLAMA_ARG_N_GPU_LAYERS) {
    process.env.LLAMA_ARG_N_GPU_LAYERS = '0';
  }
}

applyQmdCpuOnlyDefaults();

/** Initialization */
const slackConfig = AppConfig.getSlackConfig();

function createReceiver(): ExpressReceiver | undefined {
  if (slackConfig.socketMode) {
    return undefined;
  }

  if (slackConfig.mode === 'oauth') {
    return new ExpressReceiver({
      signingSecret: slackConfig.signingSecret,
      clientId: slackConfig.clientId,
      clientSecret: slackConfig.clientSecret,
      stateSecret: slackConfig.stateSecret,
      redirectUri: slackConfig.redirectUri,
      installationStore: new SqliteSlackInstallationStore(),
      scopes: slackConfig.scopes,
      installerOptions: {
        directInstall: false,
        installPath: '/slack/install',
        redirectUriPath: '/slack/oauth_redirect',
      },
    });
  }

  return new ExpressReceiver({
    signingSecret: slackConfig.signingSecret,
  });
}

const receiver = createReceiver();

const clientOptions = {
  retryConfig: {
    retries: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 30000,
    randomize: true,
  },
};

const app =
  slackConfig.mode === 'oauth'
    ? new App({
        socketMode: false,
        signingSecret: slackConfig.signingSecret,
        logLevel: LogLevel.INFO,
        receiver,
        clientOptions,
      })
    : new App({
        token: slackConfig.botToken,
        socketMode: slackConfig.socketMode,
        signingSecret: slackConfig.signingSecret,
        logLevel: LogLevel.INFO,
        appToken: slackConfig.socketMode ? slackConfig.appToken : undefined,
        receiver: receiver,
        clientOptions,
      });

// 전역 사용량 모니터 초기화 및 미들웨어 등록
SlackUsageMonitor.getInstance().initializeGlobalHook();
// 모든 요청에 대해 행위자(userId) 컨텍스트를 주입
app.use(usageMonitoringMiddleware);

const gitHubSyncService = GitHubSyncService.getInstance();
const vectorStore = VectorStoreService.getInstance();

function getExpressRouter(): any {
  // HTTP mode: use the ExpressReceiver's router
  if (receiver) return receiver.router;
  // Socket Mode: Bolt still starts an Express server internally via SocketModeReceiver
  return (app as any).receiver?.router;
}

function setupPublicSite(): void {
  const router = getExpressRouter();
  if (!router) return;

  const publicRoot = path.join(process.cwd(), 'public');
  const docsAppRoot = path.join(publicRoot, 'docs-app');
  const docsAppIndex = path.join(docsAppRoot, 'index.html');

  router.get('/', (_req: any, res: any) => {
    res.sendFile(path.join(publicRoot, 'index.html'));
  });

  router.get('/assets/:fileName', (req: any, res: any) => {
    const fileName = String(req.params.fileName || '');
    const allowedFiles = new Set(['site.css', 'site.js']);

    if (!allowedFiles.has(fileName)) {
      return res.status(404).send('Not found');
    }

    return res.sendFile(path.join(publicRoot, 'assets', fileName));
  });

  router.get('/healthz', (_req: any, res: any) => {
    res.status(200).json({ ok: true });
  });

  router.get('/readyz', (_req: any, res: any) => {
    res.status(200).json({
      ok: true,
      slackMode: slackConfig.mode,
      qmdRetrieval: true,
    });
  });

  // Serve built SPA assets (JS, CSS, etc.)
  if (fs.existsSync(docsAppRoot)) {
    const serveStatic = require('serve-static');
    router.use('/docs-app', serveStatic(docsAppRoot));
  }

  // API: return raw markdown for a file in the workspace mirror
  router.get('/api/docs/:workspaceId/*', async (req: any, res: any) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const filePath = String(req.params[0] || '');

      if (!filePath) {
        return res.status(400).json({ error: 'filePath is required' });
      }

      const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
      const resolved = path.resolve(repoRoot, filePath);

      if (!resolved.startsWith(path.resolve(repoRoot))) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const content = await fs.promises.readFile(resolved, 'utf-8');
      return res.json({ content, filePath });
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // SPA fallback: /docs/* → serve SPA index.html
  router.get('/docs/*', (_req: any, res: any) => {
    if (fs.existsSync(docsAppIndex)) {
      return res.sendFile(docsAppIndex);
    }
    return res.status(503).send('Docs viewer not built. Run: pnpm build:web');
  });
}

function shouldWarmupQmdOnStartup(): boolean {
  return process.env.QMD_WARMUP_ON_STARTUP !== 'false';
}

function warmupQmdServicesOnStartup(workspaceId: string): void {
  scheduleQmdWarmup({
    workspaceId,
    reason: 'startup',
    enabled: shouldWarmupQmdOnStartup(),
  });
}

/** Register Listeners */
registerListeners(app);
setupPublicSite();

// Note: app_home_opened event is registered in registerListeners()

/** GitHub Webhook Setup */
const setupGitHubWebhook = () => {
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!githubWebhookSecret) {
    app.logger.warn('GITHUB_WEBHOOK_SECRET not set. GitHub webhooks will not be verified.');
  }

  try {
    if (slackConfig.mode === 'oauth') {
      app.logger.info('OAuth mode detected. GitHub webhook auto-reload is not enabled yet for multi-workspace mode.');
      return;
    }

    // Only setup webhook in HTTP mode (not Socket Mode)
    const isSocketMode = slackConfig.socketMode;

    if (isSocketMode) {
      app.logger.info('Socket Mode detected. GitHub webhook endpoint is not available in Socket Mode.');
      app.logger.info(
        'For webhook functionality, please use HTTP Mode and expose the server with ngrok or deploy to a server.',
      );
      return;
    }

    if (!receiver) {
      app.logger.warn('ExpressReceiver not available. GitHub webhook endpoint cannot be configured.');
      return;
    }

    // Add raw body parser middleware for webhook endpoint (for signature verification)
    receiver.router.use('/webhook/github', (req: any, _res: any, next: any) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: any) => {
        body += chunk;
      });
      req.on('end', () => {
        req.rawBody = body;
        try {
          req.body = JSON.parse(body);
        } catch (e) {
          req.body = {};
        }
        next();
      });
    });

    // GitHub webhook endpoint using ExpressReceiver router
    receiver.router.post('/webhook/github', async (req: any, res: any) => {
      try {
        const body = req.rawBody || JSON.stringify(req.body);
        const signature = req.get('X-Hub-Signature-256') || '';

        // Verify webhook signature if secret is configured
        if (githubWebhookSecret && signature) {
          const isValid = verifyGitHubSignature(body, signature, githubWebhookSecret);
          if (!isValid) {
            app.logger.warn('Invalid GitHub webhook signature');
            return res.status(401).send('Unauthorized');
          }
        }

        const webhookPayload = req.body;
        const eventType = req.get('X-GitHub-Event');

        app.logger.info(`GitHub webhook received: ${eventType}`);

        // Handle push events
        if (eventType === 'push') {
          await handleGitHubPushEvent(webhookPayload, app.client, app.logger);
          app.logger.info('GitHub push event processed successfully');
        } else {
          app.logger.info(`Ignoring GitHub event: ${eventType}`);
        }

        res.status(200).send('OK');
      } catch (error) {
        app.logger.error('Error processing GitHub webhook:', error);
        res.status(500).send('Internal Server Error');
      }
    });

    app.logger.info('GitHub webhook endpoint configured at /webhook/github using ExpressReceiver router');
  } catch (error) {
    app.logger.error('Failed to setup GitHub webhook endpoint:', error);
  }
};

// Setup GitHub webhook (works for both Socket Mode and HTTP Mode)
setupGitHubWebhook();

async function initializeSingleWorkspaceOnStartup(): Promise<{
  workspaceId: string;
  repoInfo: Awaited<ReturnType<typeof getGithubRepo>>;
}> {
  const bootstrap = await ensureWorkspaceInitialized(app.client);
  const { workspaceId, workspaceOwner } = bootstrap;

  // API 호출 사이에 짧은 지연 (rate limit 방지)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 저장된 GitHub 저장소 정보 가져오기
  const repoInfo = await getGithubRepo(workspaceId);

  if (repoInfo) {
    app.logger.info(`Using saved GitHub repository: ${repoInfo.owner}/${repoInfo.repo}`);

    try {
      const { markdownFiles, loadedFrom } = await gitHubSyncService.loadWorkspaceMarkdownFiles({
        workspaceId,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        branch: repoInfo.branch,
        path: repoInfo.path,
        userId: workspaceOwner,
        source: 'startup',
      });

      if (markdownFiles.length > 0) {
        app.logger.info(`Loaded ${markdownFiles.length} markdown files from ${loadedFrom}.`);
        await vectorStore.setMarkdownFiles(markdownFiles, {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          workspaceId: workspaceId,
        });
      } else {
        app.logger.info('No markdown files available from mirror or GitHub. Starting with empty store.');
        await vectorStore.setMarkdownFiles([], { owner: 'empty', repo: 'empty' });
      }
    } catch (error) {
      app.logger.info('Connected GitHub repository not accessible. Starting with empty store.');
      await vectorStore.setMarkdownFiles([], { owner: 'empty', repo: 'empty' });
    }
  } else {
    app.logger.info('No GitHub repository configured. Starting with empty vector store.');
    // Initialize empty vector store
    await vectorStore.setMarkdownFiles([], {
      owner: 'empty',
      repo: 'empty',
    });
  }

  return { workspaceId, repoInfo };
}

/** Start Bolt App */
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  app.logger.info(`Received ${signal}. Stopping Bolt app...`);

  try {
    await app.stop();
    app.logger.info('Bolt app stopped.');
    process.exit(0);
  } catch (error) {
    app.logger.error('Error while stopping Bolt app', error);
    process.exit(1);
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

(async () => {
  try {
    if (!validateCurrentProvider()) {
      app.logger.error('OpenAI configuration is invalid. Please check your environment variables.');
      app.logger.error('Required variables: OPENAI_API_KEY');
      process.exit(1);
    }
    app.logger.info(`AI Provider: ${getAIProvider()}`);
    app.logger.info('OpenAI configuration is valid');

    const singleWorkspaceStartup =
      slackConfig.mode === 'single' ? await initializeSingleWorkspaceOnStartup() : undefined;

    await app.start(process.env.PORT || 3000);
    app.logger.info('⚡️ Bolt app is running! ⚡️');
    app.logger.info(`Slack mode: ${slackConfig.mode}`);

    if (slackConfig.mode === 'oauth') {
      app.logger.info('Slack OAuth install path: /slack/install');
    }

    if (singleWorkspaceStartup?.repoInfo) {
      warmupQmdServicesOnStartup(singleWorkspaceStartup.workspaceId);
    }
  } catch (error) {
    app.logger.error('Unable to start App', error);
  }
})();
