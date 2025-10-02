import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { METEORA } from './dex_env';
import { getLbPairDecoder } from './sdk/dlmm/accounts/lbPair';
import { getSwap2InstructionDataEncoder } from './sdk/dlmm/instructions/swap2';
import { AccountsType } from './sdk/dlmm/types/accountsType';

export async function executeSkill(blockhash: string): Promise<string> {
  const connection = new Connection('http://localhost:8899', 'confirmed');
  const agentPubkey = new PublicKey(process.env.PAYER_PUBKEY ?? 'HykotrnSrgYNACXfbNiS64zPzZGbyU94bxx9SWM1jMVR');
  const programId = new PublicKey(METEORA.programId);
  const lbPair = new PublicKey(METEORA.lbPair);

  // Fetch pool state to understand token configuration
  const lbPairInfo = await connection.getAccountInfo(lbPair, 'confirmed');
  if (!lbPairInfo) throw new Error('LB pair not found on RPC');
  const lb = getLbPairDecoder().decode(new Uint8Array(lbPairInfo.data));

  const tokenXMint = new PublicKey(lb.tokenXMint);
  const tokenYMint = new PublicKey(lb.tokenYMint);
  const reserveX = new PublicKey(lb.reserveX);
  const reserveY = new PublicKey(lb.reserveY);
  const oracle = new PublicKey(lb.oracle);

  // Strategy: Try reverse direction - swap token back to SOL
  const swapYtoX = tokenXMint.equals(NATIVE_MINT) ? true : false;
  const inMint = swapYtoX ? tokenYMint : tokenXMint;
  const outMint = swapYtoX ? tokenXMint : tokenYMint;
  const amountIn = 5_000_000n; // 5 tokens (assuming 6 decimals)

  // Get token program information
  const [mintXInfo, mintYInfo] = await Promise.all([
    connection.getAccountInfo(tokenXMint, 'confirmed'),
    connection.getAccountInfo(tokenYMint, 'confirmed'),
  ]);
  if (!mintXInfo || !mintYInfo) throw new Error('Mint accounts missing');

  const tokenXProgram = mintXInfo.owner;
  const tokenYProgram = mintYInfo.owner;
  const inProgramId = inMint.equals(tokenXMint) ? tokenXProgram : tokenYProgram;
  const outProgramId = outMint.equals(tokenXMint) ? tokenXProgram : tokenYProgram;

  const inAta = getAssociatedTokenAddressSync(inMint, agentPubkey, false, inProgramId);
  const outAta = getAssociatedTokenAddressSync(outMint, agentPubkey, false, outProgramId);

  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: agentPubkey });

  // Set higher compute budget for complex operations
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));

  // Create ATAs idempotently
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      agentPubkey,
      inAta,
      agentPubkey,
      inMint,
      inProgramId,
    ),
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      agentPubkey,
      outAta,
      agentPubkey,
      outMint,
      outProgramId,
    ),
  );

  // Wrap SOL if needed for the swap
  if (inMint.equals(NATIVE_MINT)) {
    tx.add(SystemProgram.transfer({ fromPubkey: agentPubkey, toPubkey: inAta, lamports: Number(amountIn) }));
    tx.add(createSyncNativeInstruction(inAta, inProgramId));
  }

  // Prepare Meteora swap instruction with different parameters
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], programId)[0];
  const bitmapExt = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), lbPair.toBytes()], programId)[0];
  const memoProgram = new PublicKey(METEORA.memoProgram);

  // Use pre-fetched bin arrays from dex_env
  const binArrayPubkeys = Array.isArray(METEORA.binArrays) ? METEORA.binArrays : [];
  const remaining = binArrayPubkeys.slice(0, 4).map((pk) => ({
    pubkey: new PublicKey(pk),
    isSigner: false,
    isWritable: true,
  }));

  const data = getSwap2InstructionDataEncoder().encode({
    amountIn,
    minAmountOut: 0n, // Accept any amount for maximum flexibility
    remainingAccountsInfo: {
      slices: [
        { accountsType: AccountsType.TransferHookX, length: 0 },
        { accountsType: AccountsType.TransferHookY, length: 0 },
      ],
    },
  });

  const swapIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: bitmapExt, isSigner: false, isWritable: false },
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: inAta, isSigner: false, isWritable: true },
      { pubkey: outAta, isSigner: false, isWritable: true },
      { pubkey: tokenXMint, isSigner: false, isWritable: false },
      { pubkey: tokenYMint, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: inAta, isSigner: false, isWritable: true }, // host_fee_in
      { pubkey: agentPubkey, isSigner: true, isWritable: false },
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: memoProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.from(data),
  });

  tx.add(swapIx);

  // Close wrapped SOL account if we used it
  if (inMint.equals(NATIVE_MINT)) {
    tx.add(createCloseAccountInstruction(inAta, agentPubkey, agentPubkey));
  }

  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
