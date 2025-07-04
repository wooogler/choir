/**
 * LLM configuration validation and management for both Azure OpenAI and OpenAI
 */

export function validateAzureOpenAIConfig(): boolean {
  const requiredVars = [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME',
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable: ${varName}`);
      return false;
    }
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (endpoint && !endpoint.match(/^https:\/\/[^.]+\.openai\.azure\.com\/$/)) {
    console.error('Invalid AZURE_OPENAI_ENDPOINT format. Expected: https://your-resource-name.openai.azure.com/');
    return false;
  }

  console.info('Azure OpenAI configuration is valid');
  return true;
}

export function validateOpenAIConfig(): boolean {
  const requiredVars = ['OPENAI_API_KEY'];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable: ${varName}`);
      return false;
    }
  }

  console.info('OpenAI configuration is valid');
  return true;
}

export function getAzureOpenAIConfig() {
  return {
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
    embeddingsDeploymentName: process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME,
  };
}

export function getOpenAIConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    embeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-small',
  };
}

export function isAzureOpenAIEnabled(): boolean {
  return (
    process.env.AI_PROVIDER === 'azure' || !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT)
  );
}

export function isOpenAIEnabled(): boolean {
  return process.env.AI_PROVIDER === 'openai' || !!process.env.OPENAI_API_KEY;
}

export function getAIProvider(): 'azure' | 'openai' {
  if (process.env.AI_PROVIDER === 'openai') {
    return 'openai';
  }
  if (process.env.AI_PROVIDER === 'azure') {
    return 'azure';
  }
  
  // Default behavior: prefer Azure if available, otherwise OpenAI
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    return 'azure';
  }
  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }
  
  return 'azure'; // Default fallback
}

export function validateCurrentProvider(): boolean {
  const provider = getAIProvider();
  
  if (provider === 'azure') {
    return validateAzureOpenAIConfig();
  } else {
    return validateOpenAIConfig();
  }
}