import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from '@slack/bolt';
import archiver from 'archiver';
import { getDataPath } from 'services/common/data-path';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { requireManagerForAction } from './management/shared';

/**
 * Interaction logs from every workspace are written into shared daily files, so
 * a raw copy would hand one workspace's manager every other workspace's Q&A
 * content and user names. Return only the JSONL lines whose `workspaceId`
 * matches the requester; malformed lines are dropped.
 */
function filterLogLinesForWorkspace(filePath: string, workspaceId: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).workspaceId === workspaceId) {
        kept.push(line);
      }
    } catch {
      // Skip unparseable lines rather than leak them.
    }
  }
  return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

export const registerLogDownloadHandlers = (app: App) => {
  app.action('download_today_logs', async ({ ack, body, client, context, logger }) => {
    await ack();

    const t = tForRequest(context);

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const today = new Date().toISOString().split('T')[0];

      const logsDir = getDataPath('logs');

      if (!fs.existsSync(logsDir)) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.none'),
        });
        return;
      }

      const logFiles = fs
        .readdirSync(logsDir)
        .filter((file: string) => file.endsWith('.jsonl') && file.includes(today));

      if (logFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.noneToday', { date: today }),
        });
        return;
      }

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: t('appHome.logs.today.preparing'),
      });

      const zipPath = getDataPath(`today-logs-${workspaceId}-${Date.now()}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const archivePromise = new Promise<void>((resolve, reject) => {
        output.on('close', () => {
          logger.info(`Archive created: ${archive.pointer()} total bytes`);
          resolve();
        });

        archive.on('error', (err: Error) => {
          logger.error('Archive error:', err);
          reject(err);
        });

        archive.on('warning', (err: archiver.ArchiverError) => {
          if (err.code === 'ENOENT') {
            logger.warn('Archive warning:', err);
          } else {
            reject(err);
          }
        });
      });

      archive.pipe(output);

      for (const logFile of logFiles) {
        const filePath = path.join(logsDir, logFile);
        if (fs.existsSync(filePath)) {
          const filtered = filterLogLinesForWorkspace(filePath, workspaceId);
          if (filtered) {
            archive.append(filtered, { name: logFile });
          }
        }
      }

      await archive.finalize();
      await archivePromise;

      try {
        const fileSize = fs.statSync(zipPath).size;
        const fileName = `today-logs-${today}.zip`;

        const dmChannel = await client.conversations.open({
          users: body.user.id,
        });

        if (!dmChannel.channel?.id) {
          throw new Error('Could not open DM channel');
        }

        await client.files.uploadV2({
          channel_id: dmChannel.channel.id,
          file: fs.createReadStream(zipPath),
          filename: fileName,
          title: t('appHome.logs.today.fileTitle'),
          initial_comment: t('appHome.logs.today.comment', { date: today }),
        });

        fs.unlinkSync(zipPath);

        logger.info(`Today's interaction logs (${fileSize} bytes) downloaded by user ${body.user.id}`);

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.today.uploaded', { size: Math.round(fileSize / 1024) }),
        });
      } catch (uploadError) {
        logger.error('Error uploading today log file:', uploadError);

        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.upload'),
        });
      }
    } catch (error) {
      logger.error('Error downloading today interaction logs:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: t('appHome.logs.error.prepare'),
      });
    }
  });

  app.action('download_all_logs', async ({ ack, body, client, context, logger }) => {
    await ack();

    const t = tForRequest(context);

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);

      const logsDir = getDataPath('logs');

      if (!fs.existsSync(logsDir)) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.none'),
        });
        return;
      }

      const logFiles = fs.readdirSync(logsDir).filter((file: string) => file.endsWith('.jsonl'));

      if (logFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.noneAll'),
        });
        return;
      }

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: t('appHome.logs.all.preparing'),
      });

      const timestamp = new Date().toISOString().split('T')[0];
      const zipPath = getDataPath(`all-logs-${workspaceId}-${Date.now()}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const archivePromise = new Promise<void>((resolve, reject) => {
        output.on('close', () => {
          logger.info(`Archive created: ${archive.pointer()} total bytes`);
          resolve();
        });

        archive.on('error', (err: Error) => {
          logger.error('Archive error:', err);
          reject(err);
        });

        archive.on('warning', (err: archiver.ArchiverError) => {
          if (err.code === 'ENOENT') {
            logger.warn('Archive warning:', err);
          } else {
            reject(err);
          }
        });
      });

      archive.pipe(output);

      for (const logFile of logFiles) {
        const filePath = path.join(logsDir, logFile);
        if (fs.existsSync(filePath)) {
          const filtered = filterLogLinesForWorkspace(filePath, workspaceId);
          if (filtered) {
            archive.append(filtered, { name: logFile });
          }
        }
      }

      await archive.finalize();
      await archivePromise;

      try {
        const fileSize = fs.statSync(zipPath).size;
        const fileName = `all-logs-${timestamp}.zip`;

        const dmChannel = await client.conversations.open({
          users: body.user.id,
        });

        if (!dmChannel.channel?.id) {
          throw new Error('Could not open DM channel');
        }

        await client.files.uploadV2({
          channel_id: dmChannel.channel.id,
          file: fs.createReadStream(zipPath),
          filename: fileName,
          title: t('appHome.logs.all.fileTitle'),
          initial_comment: t('appHome.logs.all.comment'),
        });

        fs.unlinkSync(zipPath);

        logger.info(`All interaction logs (${fileSize} bytes) downloaded by user ${body.user.id}`);

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.all.uploaded', { size: Math.round(fileSize / 1024) }),
        });
      } catch (uploadError) {
        logger.error('Error uploading all log file:', uploadError);

        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.logs.error.upload'),
        });
      }
    } catch (error) {
      logger.error('Error downloading all interaction logs:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: t('appHome.logs.error.prepare'),
      });
    }
  });
};
