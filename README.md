# CHOIR - AI-Powered Slack Bot

CHOIR is an AI-powered Slack bot designed to help organizations manage and leverage their collective knowledge stored as markdown files in GitHub repositories.

## Installation

#### Server Access

Connect to the server:
```bash
ssh sangwonlee@choir.cs.vt.edu
# Enter password when prompted
```

#### Clone Repository

```bash
git clone https://github.com/wooogler/choir.git choir-{workspace_name}
cd choir-{workspace_name}
```

#### Install Dependencies

```bash
pnpm install
```

#### Create a Slack App

1. Open [https://api.slack.com/apps/new](https://api.slack.com/apps/new) and choose "From an app manifest"
2. Choose the workspace you want to install the application to
3. Copy the contents of [manifest.json](./manifest.json) into the text box that says `*Paste your manifest code here*` (within the JSON tab)
4. **Important**: Update the `event_subscriptions.request_url` and `interactivity.request_url` in the manifest to: `https://choir.cs.vt.edu/{workspace_name}/slack/events`
5. Click _Next_, review the configuration and click _Create_
6. Click _Install to Workspace_ and _Allow_ on the screen that follows

#### Environment Variables

1. Copy `env.sample` to `.env`
2. Configure your Slack app credentials:
   - Go to your app's _OAuth & Permissions_ page and copy the _Bot User OAuth Token_ to `SLACK_BOT_TOKEN`
   - Go to _Basic Information_ and create an app-level token with `connections:write` scope for `SLACK_APP_TOKEN`
   - Copy the _Signing Secret_ from _Basic Information_ to `SLACK_SIGNING_SECRET`

3. Configure OpenAI (default AI provider):

```env
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# OpenAI Configuration
OPENAI_API_KEY=your-openai-api-key

# GitHub Integration
GITHUB_TOKEN=your-github-personal-access-token
GITHUB_WEBHOOK_SECRET=your-webhook-secret  # Optional but recommended for security

# Server Configuration
PORT=3000  # Use an available port (3000, 3001, 3002, etc.)

# Optional
MANAGER_PROMOTION_PASSWORD=your-manager-password
CHOIR_CONSENT_FORM_URL=https://your-consent-form-url
```

#### Configure Nginx

1. Edit the `nginx-test-server.conf` file to add your workspace configuration:

```nginx
# Add this block for your workspace (replace {workspace_name} and {port})
location = /{workspace_name}/slack/events {
    proxy_pass http://localhost:{port}/slack/events;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 60s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
}
```

2. Replace the nginx configuration:

```bash
sudo cp nginx-test-server.conf /etc/nginx/sites-available/test-server
sudo nginx -t  # Test configuration
sudo systemctl reload nginx
```

#### Deploy with PM2

Start the application with PM2 (replace `{workspace_name}` with your actual workspace name):

```bash
pm2 start "pnpm run dev:prod" --name "choir-{workspace_name}"
```

## GitHub Webhook Auto-Reload

CHOIR supports automatic document reloading when changes are pushed to your GitHub repository. This eliminates the need to manually click "Reload from Github" in the App Home.

### Setup GitHub Webhook

1. **Go to your GitHub repository** → Settings → Webhooks → Add webhook

2. **Configure the webhook**:
   - **Payload URL**: `https://choir.cs.vt.edu/{workspace_name}/webhook/github`
   - **Content type**: `application/json`
   - **Secret**: Enter the same value as `GITHUB_WEBHOOK_SECRET` in your .env file (optional but recommended)
   - **Events**: Select "Push events"
   - **Active**: ✅ Checked

3. **Update your Nginx configuration** (if not already done):

```nginx
# Add this location block for webhook endpoint
location = /{workspace_name}/webhook/github {
    proxy_pass http://localhost:{port}/webhook/github;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
}
```

4. **Reload Nginx**:
```bash
sudo nginx -t  # Test configuration
sudo systemctl reload nginx
```

### How It Works

1. **Push Detection**: When you push changes to your GitHub repository, GitHub sends a webhook event to CHOIR
2. **Repository Matching**: CHOIR checks if the repository matches the one configured for your workspace
3. **Branch Verification**: Only pushes to the configured branch (usually `main`) trigger auto-reload
4. **Automatic Reload**: CHOIR automatically fetches the latest files and updates the vector store
5. **Manager Notification**: Workspace managers receive Slack notifications about the auto-reload status

### Development Testing

For local development, use ngrok to expose your local server:

```bash
# Terminal 1: Start CHOIR
pnpm run dev

# Terminal 2: Expose local server
ngrok http 3000
```

Then use the ngrok URL in your webhook configuration:
```
Payload URL: https://abc123.ngrok.io/webhook/github
```

### Security Notes

- The `GITHUB_WEBHOOK_SECRET` is optional but **highly recommended** for production
- It prevents malicious webhook requests by verifying that requests actually come from GitHub
- Without the secret, the webhook will still work but with reduced security
