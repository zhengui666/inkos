import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Usage } from '@earendil-works/pi-ai';
import type { RuntimeHost } from '../runtime/host.js';
import { artifactPath, saveArtifact } from '../works/artifacts.js';
import { commitRevision } from '../works/service.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { COVER_PROVIDER_PRESETS, normalizeCoverModelReference } from '../llm/cover-providers.js';

export function extractImage(payload: any): { data?: string; url?: string; mimeType: string } | undefined {
  const direct = payload?.data?.find((item: any) => item.b64_json || item.url);
  if (direct) return { data: direct.b64_json, url: direct.url, mimeType: 'image/png' };
  for (const item of payload?.output ?? []) {
    if (item.type === 'image_generation_call' && item.result) return { data: item.result, mimeType: 'image/png' };
    for (const content of item.content ?? []) if (content.result || content.image_base64) return { data: content.result ?? content.image_base64, mimeType: 'image/png' };
  }
  for (const candidate of payload?.candidates ?? []) for (const part of candidate.content?.parts ?? []) {
    const image = part.inlineData ?? part.inline_data;
    if (image?.data) return { data: image.data, mimeType: image.mimeType ?? image.mime_type ?? 'image/png' };
  }
  return undefined;
}
export async function generateMedia(host: RuntimeHost, input: { workId: string; prompt: string; provider?: string; modelId?: string; reference?: string; size?: string; revisionId?: string }, signal?: AbortSignal) {
  const work = await host.works.get(input.workId); let bytes: Uint8Array; let mimeType = 'image/png'; let usage: Usage | undefined;
  const referenceBytes = input.reference ? await readFile(artifactPath(host.rootDir, input.reference)) : undefined;
  const reference = referenceBytes?.toString('base64');
  const referenceMime = referenceBytes?.[0] === 0xff && referenceBytes[1] === 0xd8 ? 'image/jpeg' : referenceBytes?.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png';
  const imageModel = input.provider && input.modelId ? host.models.getModelOfType('image', input.provider, input.modelId) : undefined;
  if (imageModel) {
    const response = await host.models.generateImages(imageModel, { input: [{ type: 'text', text: input.prompt }, ...(reference ? [{ type: 'image' as const, data: reference, mimeType: referenceMime }] : [])] }, { signal });
    const image = response.output.find(item => item.type === 'image');
    if (response.stopReason === 'error' || !image) throw new Error(response.errorMessage ?? 'Image provider returned no image');
    bytes = Buffer.from(image.data, 'base64'); mimeType = image.mimeType; usage = response.usage;
  } else {
    const raw = JSON.parse(await readFile(join(host.rootDir, 'inkos.json'), 'utf8'));
    const config = raw.media ?? raw.llm?.cover;
    const preset = COVER_PROVIDER_PRESETS.find(item => item.service === (input.provider ?? config?.service));
    const baseUrl = config?.baseUrl ?? process.env.INKOS_COVER_BASE_URL ?? preset?.baseUrl;
    if (!baseUrl) throw new Error('Configure an image model or media service');
    let legacySecrets: any = {};
    try { legacySecrets = JSON.parse(await readFile(join(host.rootDir, '.inkos', 'secrets.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const provider = input.provider ?? config?.service;
    const credential = provider ? await host.credentials.read(provider) : undefined;
    const key = credential?.type === 'api_key' ? credential.key : undefined;
    const apiKey = key ?? process.env[config?.apiKeyEnv ?? 'INKOS_COVER_API_KEY'] ?? legacySecrets.services?.[`cover:${provider}`]?.apiKey ?? legacySecrets.services?.[provider]?.apiKey ?? legacySecrets[`cover:${provider}`]?.apiKey;
    if (!apiKey) throw new Error('Image service credentials are missing');
    const model = preset ? normalizeCoverModelReference(input.modelId, preset, config?.model) : input.modelId ?? config?.model;
    if (!model) throw new Error('Image service model is missing');
    const api = config?.api ?? preset?.api ?? 'images';
    const endpoint = config?.endpoint ?? process.env.INKOS_COVER_ENDPOINT ?? (api === 'gemini' ? `${baseUrl}/models/${encodeURIComponent(model)}:generateContent` : `${baseUrl}/${api === 'responses' ? 'responses' : 'images/generations'}`);
    let body: string | FormData; const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }; let url = endpoint;
    if (api === 'gemini') { headers['x-goog-api-key'] = apiKey; delete headers.Authorization; body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input.prompt }, ...(reference ? [{ inlineData: { mimeType: referenceMime, data: reference } }] : [])] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }); }
    else if (api === 'responses') body = JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }, ...(reference ? [{ type: 'input_image', image_url: `data:${referenceMime};base64,${reference}` }] : [])] }], tools: [{ type: 'image_generation', size: input.size ?? '1024x1536' }] });
    else if (reference) { url = endpoint.replace(/\/images\/(?:generations|edits)\/?$/u, '/images/edits'); const form = new FormData(); form.set('model', model); form.set('prompt', input.prompt); form.set('size', input.size ?? '1024x1536'); form.set('image', new Blob([Buffer.from(reference, 'base64')], { type: referenceMime }), `reference.${referenceMime === 'image/jpeg' ? 'jpg' : referenceMime === 'image/webp' ? 'webp' : 'png'}`); delete headers['content-type']; body = form; }
    else body = JSON.stringify({ model, prompt: input.prompt, n: 1, size: input.size ?? '1024x1536' });
    const response = await fetch(url, { method: 'POST', headers, body, signal });
    if (!response.ok) throw new Error(`Image service failed: HTTP ${response.status}`);
    const image = extractImage(await response.json()); if (!image) throw new Error('Image service returned no image');
    if (image.data) { bytes = Buffer.from(image.data, 'base64'); mimeType = image.mimeType; }
    else { const downloaded = await fetch(image.url!, { signal }); if (!downloaded.ok) throw new Error(`Image download failed: ${downloaded.status}`); bytes = new Uint8Array(await downloaded.arrayBuffer()); mimeType = downloaded.headers.get('content-type') ?? image.mimeType; }
  }
  const revision = await saveArtifact(host.rootDir, { id: input.revisionId ?? randomUUID(), workId: work.id, artifactId: randomUUID(), title: `${work.title} — illustration`, format: mimeType, content: bytes, metadata: { prompt: input.prompt, role: 'media' } });
  await host.harness.commit(tx => commitRevision(tx, work, revision), BACKGROUND_CONTEXT);
  return { revision, usage };
}
