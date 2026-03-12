/**
 * Merkle Tree — Cryptographic proofs for deliveries
 * Every delivery gets a Merkle root that the customer can verify.
 */

export async function computeMerkleRoot(fingerprints) {
  if (fingerprints.length === 0) return null;
  if (fingerprints.length === 1) return await sha256(fingerprints[0]);

  let leaves = [];
  for (const fp of fingerprints) {
    leaves.push(await sha256(fp));
  }

  // Pad to even number
  if (leaves.length % 2 !== 0) {
    leaves.push(leaves[leaves.length - 1]);
  }

  while (leaves.length > 1) {
    const next = [];
    for (let i = 0; i < leaves.length; i += 2) {
      const combined = leaves[i] + leaves[i + 1];
      next.push(await sha256(combined));
    }
    leaves = next;
    if (leaves.length > 1 && leaves.length % 2 !== 0) {
      leaves.push(leaves[leaves.length - 1]);
    }
  }

  return leaves[0];
}

async function sha256(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export { sha256 };
