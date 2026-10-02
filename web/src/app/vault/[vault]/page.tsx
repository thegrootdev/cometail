import VaultView from "./VaultView";

export default async function VaultPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  return <VaultView vaultStr={vault} />;
}
