export interface MetadataIntent {
  owner: string;
  name: string;
  symbol: string;
  description: string;
  imageHash: string;
  issuedAt: number;
  origin: string;
  /** Optional socials, https only; bound by the signature like every other field. */
  links?: { x?: string; telegram?: string; discord?: string; website?: string };
}
export function metadataProofMessage(intent: MetadataIntent) {
  return `COMETAIL token identity upload\n${JSON.stringify(intent)}\nThis message authorizes image and metadata storage only. It does not authorize a transaction.`;
}
