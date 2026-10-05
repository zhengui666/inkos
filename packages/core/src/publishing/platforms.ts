import { PublishingPlatformSchema, type PublishingPlatform } from './contracts.js';

/** These are local manual-delivery capabilities, not undocumented author APIs. */
const platforms: Record<PublishingPlatform, {name: string; guidance: string[]; sources: string[]}> = {
  fanqie: {
    name: '番茄小说',
    guidance: ['Check originality, AI-content rules and the book’s exclusive/first-publication agreement before manual submission.'],
    sources: ['https://fanqienovel.com/writer/zone/article/7602950185735438398',
      'https://fanqienovel.com/writer/zone/help/article?rank1=10226&rank2=10227&rank3=0'],
  },
  qidian: {
    name: '起点中文网',
    guidance: ['Check the author portal’s current submission requirements and your book’s contract. Yuewen content-distribution APIs are not an author publishing integration.'],
    sources: ['https://help.yuewen.com/help?siteId=2', 'https://open.yuewen.com/docs/1003.html'],
  },
  qimao: {
    name: '七猫中文网',
    guidance: ['Check AI disclosure and originality requirements. Third-party platform access requires platform permission; this adapter makes no platform requests.'],
    sources: ['https://zhushou.qimao.com/writer-rules/68464fdfe4a81e7ec312f874/',
      'https://zhushou.qimao.com/writer-rules/68466f6ae4a81e7ec312f8cd/'],
  },
  meganovel: {
    name: 'MegaNovel',
    guidance: [
      'Prepare a manual submission only. Use automated access only with explicit platform authorization under its current terms; this adapter makes no platform requests.',
      'AI writing is discouraged and does not guarantee a contract. Review current content quality, originality and AI requirements with the platform before submitting.',
      'Confirm author eligibility, payout requirements and the actual rights/exclusivity agreement separately. A prepared package or reported publication is not contract acceptance or income.',
    ],
    sources: ['https://www.meganovel.com/terms', 'https://www.meganovel.com/writer_benefit'],
  },
  goodnovel: {
    name: 'GoodNovel',
    guidance: [
      'Prepare a manual submission only. Use automated access only with explicit platform authorization under its current terms; this adapter makes no platform requests.',
      'AI writing is discouraged and does not guarantee a contract. Review current content quality, originality and AI requirements with the platform before submitting.',
      'Confirm author eligibility, payout requirements and the actual rights/exclusivity agreement separately. A prepared package or reported publication is not contract acceptance or income.',
    ],
    sources: ['https://www.goodnovel.com/terms', 'https://www.goodnovel.com/writer_benefit'],
  },
  dreame: {
    name: 'Dreame / Stary Writing',
    guidance: [
      'Prepare a manual submission through Stary Writing only. Use automated access or integration only with explicit platform authorization under its current terms; this adapter makes no platform requests.',
      'Verify the platform’s current AI-content and originality requirements before submitting; this capability does not establish acceptance of AI-generated fiction.',
      'Confirm author eligibility, payout requirements and the actual rights/exclusivity agreement separately. A prepared package or reported publication is not contract acceptance or income.',
    ],
    sources: ['https://www.starywriting.com/en/help/term', 'https://www.starywriting.com/en/help/contentGuideline',
      'https://www.starywriting.com/en/activity/benefits'],
  },
};
export function getPublishingCapability(platform: PublishingPlatform) {
  return {
    platform: PublishingPlatformSchema.parse(platform), ...platforms[platform],
    adapter: 'manual' as const, preparePackage: 'available' as const,
    automaticSubmission: 'unavailable' as const, remoteVerification: 'unavailable' as const,
    reason: 'No authorized ordinary-author publishing API integration has been verified or implemented.',
  };
}
export function listPublishingCapabilities() {
  return PublishingPlatformSchema.options.map(getPublishingCapability);
}
