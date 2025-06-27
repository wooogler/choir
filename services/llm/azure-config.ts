/**
 * Azure OpenAI 설정 검증 및 관리
 */

export function validateAzureOpenAIConfig(): boolean {
  const requiredVars = [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME'
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable: ${varName}`);
      return false;
    }
  }

  // 엔드포인트 형식 검증
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (endpoint && !endpoint.match(/^https:\/\/[^.]+\.openai\.azure\.com\/$/)) {
    console.error('Invalid AZURE_OPENAI_ENDPOINT format. Expected: https://your-resource-name.openai.azure.com/');
    return false;
  }

  console.info('Azure OpenAI configuration is valid');
  return true;
}

export function getAzureOpenAIConfig() {
  return {
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
    deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
    embeddingsDeploymentName: process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME,
  };
}

export function isAzureOpenAIEnabled(): boolean {
  return process.env.AI_PROVIDER === 'azure' || 
         !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
} 