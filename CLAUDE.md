# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CHOIR is an AI-powered Slack bot designed to help organizations manage and leverage their collective knowledge stored as markdown files in GitHub repositories. Operating within Slack workspaces, it provides intelligent document management, Q&A capabilities, and knowledge extraction features that enable team members to easily access, utilize, and manage their organizational memory.

The application integrates with GitHub repositories to keep documentation synchronized and uses vector search with Azure OpenAI for semantic Q&A. Each Slack workspace operates with its own dedicated server instance, ensuring isolated and secure access to organizational knowledge.

## Research Context & Purpose

CHOIR was developed as a research tool specifically designed for academic research lab environments. The application studies how research teams interact with their knowledge management systems in real-world scenarios, focusing on the unique dynamics of university research settings.

### Target Environment: University Research Labs

The system is designed for research lab environments where teams need to:
- Share and access research tips, protocols, and best practices
- Maintain lab policies and procedural documentation
- Preserve institutional knowledge across changing team members
- Enable quick knowledge discovery and application in research workflows

### Document Structure & Content

CHOIR is optimized for markdown documents with simple, structured formats:
- **Section-based organization**: Documents organized with clear headings and sections
- **List-heavy content**: Emphasis on bulleted lists, numbered procedures, and step-by-step guides
- **Paragraph summaries**: Brief explanatory paragraphs accompanying structured information
- **Topic-specific repositories**: Multiple markdown files covering different research areas and policies

### Research Methodology

The research approach combines quantitative and qualitative methods:
- **Descriptive log analysis**: JSONL interaction logs provide behavioral data on knowledge access patterns
- **Qualitative interviews**: In-depth user interviews reveal insights into knowledge management practices and user experience
- **No performance metrics**: Focus on understanding usage patterns rather than measuring system performance

This mixed-methods approach enables comprehensive understanding of how AI-assisted knowledge management impacts research team dynamics and productivity.

## Common Development Commands

```bash
# Development
pnpm run dev              # Development mode with ts-node
pnpm run dev:watch        # Watch mode with nodemon
pnpm run dev:prod         # Production mode locally

# Build & Quality
pnpm run build           # TypeScript compilation to dist/
pnpm run lint            # Run Biome linting
pnpm run lint:fix        # Auto-fix linting issues
pnpm test               # Build + lint (full test suite)

# Dependencies
pnpm install            # Install dependencies using pnpm
```

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Slack Bolt Framework v4.2.0
- **AI Services**: Azure OpenAI (primary), OpenAI (fallback), LangChain
- **Vector Search**: FAISS with in-memory storage
- **Code Quality**: Biome for linting and formatting
- **GitHub Integration**: Octokit for repository operations

## Architecture Overview

### Core Service Architecture
- **Feature-based organization**: `/listeners/features/` contains domain-specific handlers
- **Service layer**: `/services/` contains business logic with singleton patterns
- **Event-driven**: Uses Slack's event system for real-time processing
- **Dependency injection**: Services are injected into event handlers

### Key Services
- **VectorStoreService**: Manages document embeddings and similarity search
- **GithubService**: Handles repository operations and document synchronization  
- **LLMService**: Orchestrates AI interactions with Azure OpenAI/OpenAI
- **WorkspaceService**: Manages multi-workspace configurations and permissions

### Data Flow
1. Slack events → Event handlers in `/listeners/features/`
2. Handlers call services in `/services/` for business logic
3. Vector search retrieves relevant context from FAISS
4. AI services generate responses using retrieved context
5. Results returned to Slack + optionally update GitHub repos

## Key File Locations

- **Entry Point**: `app.ts` - Main application bootstrap
- **Event Handlers**: `/listeners/features/` - Feature-specific Slack handlers
- **Core Services**: `/services/` - Business logic layer
- **Configuration**: `/data/` - Workspace configs and user interaction logs
- **Utilities**: `/python/` - Helper scripts for document processing

## Environment Configuration

Required environment variables:
```env
# Slack Configuration
SLACK_BOT_TOKEN=          # Bot OAuth token
SLACK_APP_TOKEN=          # App-level token for socket mode
SLACK_SIGNING_SECRET=     # Request verification

# Azure OpenAI (Primary AI Provider)
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT_NAME=
AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME=

# GitHub Integration
GITHUB_OAUTH_CLIENT_ID=     # GitHub OAuth app client ID
GITHUB_OAUTH_CLIENT_SECRET= # GitHub OAuth app client secret
GITHUB_WEBHOOK_SECRET=      # Optional secret for webhook verification

# Manager Access
MANAGER_PROMOTION_PASSWORD=  # Password for user promotion to manager
CHOIR_CONSENT_FORM_URL=      # Optional URL for research consent form
```

## Code Conventions

- **Import Paths**: Use TypeScript path mapping (`services/*`) configured in `tsconfig.json`
- **Formatting**: Biome enforces 2-space indentation, single quotes, 120 char line width
- **Error Handling**: Comprehensive logging to JSONL files in `/data/logs/`
- **Async Patterns**: Extensive use of async/await with proper error boundaries
- **Type Safety**: Strict TypeScript configuration with full type checking

## Testing & Quality

- Run `pnpm build` before commits to check for TypeScript errors
- Biome handles both linting and formatting
- Use `pnpm run lint:fix` for automatic code fixes
- All new features should include comprehensive error handling and logging

## Deployment Notes

- The app uses Slack's Socket Mode for development
- For production distribution, see `app-oauth.ts` for OAuth configuration
- Vector embeddings are stored in-memory and rebuild on restart
- Workspace configurations persist as JSON files in `/data/`
