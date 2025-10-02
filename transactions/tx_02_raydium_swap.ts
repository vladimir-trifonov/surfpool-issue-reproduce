import { PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, Connection } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { getSwapBaseInputInstruction } from './sdk/raydium_cp/instructions/swapBaseInput';
import { RAYDIUM } from './dex_env';

export async function executeSkill(blockhash: string): Promise<string> {
  const connection = new Connection('http://localhost:8899', 'confirmed');
  const agentPubkey = new PublicKey(process.env.PAYER_PUBKEY ?? 'HykotrnSrgYNACXfbNiS64zPzZGbyU94bxx9SWM1jMVR');

  // Strategy: Try reverse direction - swap USDC back to SOL for arbitrage opportunity
  const INPUT_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
  const OUTPUT_MINT = NATIVE_MINT; // wSOL
  const AMOUNT = 5_000_000n; // 5 USDC (6 decimals)
  const MIN_OUT = 0n;

  // Derive direction from pool mints
  const inputIsToken0 = RAYDIUM.token0Mint === INPUT_MINT.toBase58();
  const inputVault = new PublicKey(inputIsToken0 ? RAYDIUM.token0Vault : RAYDIUM.token1Vault);
  const outputVault = new PublicKey(inputIsToken0 ? RAYDIUM.token1Vault : RAYDIUM.token0Vault);
  const inputTokenProgram = new PublicKey(inputIsToken0 ? RAYDIUM.token0Program : RAYDIUM.token1Program);
  const outputTokenProgram = new PublicKey(inputIsToken0 ? RAYDIUM.token1Program : RAYDIUM.token0Program);
  const inputTokenMint = new PublicKey(inputIsToken0 ? RAYDIUM.token0Mint : RAYDIUM.token1Mint);
  const outputTokenMint = new PublicKey(inputIsToken0 ? RAYDIUM.token1Mint : RAYDIUM.token0Mint);

  const inAta = getAssociatedTokenAddressSync(inputTokenMint, agentPubkey);
  const outAta = getAssociatedTokenAddressSync(outputTokenMint, agentPubkey);

  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: agentPubkey });

  // Set compute budget for optimal execution
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }));

  // Create ATAs idempotently
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      agentPubkey,
      inAta,
      agentPubkey,
      inputTokenMint,
      inputTokenProgram
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      agentPubkey,
      outAta,
      agentPubkey,
      outputTokenMint,
      outputTokenProgram
    )
  );

  // Wrap SOL if needed for output
  if (outputTokenMint.equals(NATIVE_MINT)) {
    tx.add(SystemProgram.transfer({ fromPubkey: agentPubkey, toPubkey: outAta, lamports: 1 }));
    tx.add(createSyncNativeInstruction(outAta));
  }

  const rawSwapIx = getSwapBaseInputInstruction({
    payer: agentPubkey,
    authority: new PublicKey(RAYDIUM.authority),
    ammConfig: new PublicKey(RAYDIUM.ammConfig),
    poolState: new PublicKey(RAYDIUM.poolState),
    inputTokenAccount: inAta,
    outputTokenAccount: outAta,
    inputVault,
    outputVault,
    inputTokenProgram,
    outputTokenProgram,
    inputTokenMint,
    outputTokenMint,
    observationState: new PublicKey(RAYDIUM.observationKey),
    amountIn: AMOUNT,
    minimumAmountOut: MIN_OUT,
  });

  if (!rawSwapIx.programAddress) {
    throw new Error('Raydium swap builder returned empty programAddress');
  }

  const swapKeys = rawSwapIx.accounts.map((meta, index) => {
    if (!meta?.pubkey) {
      if (index === 0) {
        // Builder omitted the payer because we supplied only the pubkey – insert it manually
        return { pubkey: agentPubkey, isSigner: true, isWritable: true };
      }
      throw new Error(`Raydium swap requires account index ${index}, but builder returned none`);
    }

    const pubkey = new PublicKey(meta.pubkey);
    const isAgent = pubkey.equals(agentPubkey);
    return {
      pubkey,
      isSigner: isAgent ? true : Boolean(meta.isSigner),
      isWritable: isAgent ? true : Boolean(meta.isWritable),
    };
  });

  const swapIx = new TransactionInstruction({
    programId: new PublicKey(rawSwapIx.programAddress),
    keys: swapKeys,
    data: Buffer.from(rawSwapIx.data),
  });

  tx.add(swapIx);

  // Close wrapped SOL account if we used it
  if (outputTokenMint.equals(NATIVE_MINT)) {
    tx.add(createCloseAccountInstruction(outAta, agentPubkey, agentPubkey));
  }

  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
