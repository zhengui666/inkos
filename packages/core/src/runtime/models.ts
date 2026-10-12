import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createProvider, type CreateProviderOptions, type CredentialStore } from '@earendil-works/pi-ai';

export function projectModels(credentials: CredentialStore, custom: CreateProviderOptions[] = []) {
  const models = builtinModels({ credentials });
  for (const config of custom) models.setProvider(createProvider(config));
  return models;
}
