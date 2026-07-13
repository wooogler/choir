import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from '@slack/bolt';
import archiver from 'archiver';
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
  app.action('download_today_logs', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const today = new Date().toISOString().split('T')[0];

      const logsDir = path.join(process.cwd(), 'data', 'logs');

      if (!fs.existsSync(logsDir)) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No interaction logs found.',
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
          text: `❌ No interaction log files found for today (${today}).`,
        });
        return;
      }

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: "📊 Preparing today's interaction logs for download...",
      });

      const zipPath = path.join(process.cwd(), 'data', `today-logs-${workspaceId}-${Date.now()}.zip`);
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
          title: "Today's Interaction Logs",
          initial_comment: `📊 Here are today's interaction logs (${today}) for analysis.`,
        });

        fs.unlinkSync(zipPath);

        logger.info(`Today's interaction logs (${fileSize} bytes) downloaded by user ${body.user.id}`);

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Successfully uploaded today's interaction logs (${Math.round(fileSize / 1024)}KB)`,
        });
      } catch (uploadError) {
        logger.error('Error uploading today log file:', uploadError);

        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error uploading log files. Please try again.',
        });
      }
    } catch (error) {
      logger.error('Error downloading today interaction logs:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error preparing interaction logs. Please try again.',
      });
    }
  });

  app.action('download_all_logs', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);

      const logsDir = path.join(process.cwd(), 'data', 'logs');

      if (!fs.existsSync(logsDir)) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No interaction logs found.',
        });
        return;
      }

      const logFiles = fs.readdirSync(logsDir).filter((file: string) => file.endsWith('.jsonl'));

      if (logFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No interaction log files found.',
        });
        return;
      }

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '📊 Preparing all interaction logs for download...',
      });

      const timestamp = new Date().toISOString().split('T')[0];
      const zipPath = path.join(process.cwd(), 'data', `all-logs-${workspaceId}-${Date.now()}.zip`);
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
          title: 'All Interaction Logs',
          initial_comment: '📊 Here are all your interaction logs for analysis.',
        });

        fs.unlinkSync(zipPath);

        logger.info(`All interaction logs (${fileSize} bytes) downloaded by user ${body.user.id}`);

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Successfully uploaded all interaction logs (${Math.round(fileSize / 1024)}KB)`,
        });
      } catch (uploadError) {
        logger.error('Error uploading all log file:', uploadError);

        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error uploading log files. Please try again.',
        });
      }
    } catch (error) {
      logger.error('Error downloading all interaction logs:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error preparing interaction logs. Please try again.',
      });
    }
  });
};
