export interface MetadataIntent {
  owner: string;
  name: string;
  symbol: string;
  description: string;
  imageHash: string;
  issuedAt: number;
  origin: string;
}
export function metadataProofMessage(intent: MetadataIntent) {
  return `COMETAIL token identity upload\n${JSON.stringify(intent)}\nThis message authorizes image and metadata storage only. It does not authorize a transaction.`;
}
