import fs from "fs";
import path from "path";
import { createRequire } from "module";

// Delay loading solana libs to allow silencing native binding warnings
let Connection: any;
let PublicKey: any;
let NATIVE_MINT: any;

const requireCjs = createRequire(import.meta.url);
const DEFAULT_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

type MeteoraSdk = {
  DLMM: any;
  memoProgramId: string;
  programId: string;
};

// Silence noisy native binding warnings (e.g., "bigint: Failed to load bindings, pure JS will be used")
function silenceBindingsWarnings() {
  const origWrite = (process.stderr.write as any).bind(process.stderr);
  // @ts-ignore
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    try {
      const msg = typeof chunk === "string" ? chunk : chunk?.toString?.();
      if (
        msg &&
        msg.includes("Failed to load bindings, pure JS will be used") &&
        msg.toLowerCase().includes("bigint")
      ) {
        // Swallow this specific noisy line
        return true;
      }
    } catch {}
    return origWrite(chunk, ...args);
  }) as any;
}

function argVal(flag: string, def?: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function resolveRpcUrl(): string {
  const cli = argVal("--rpc");
  if (cli) return cli;
  const envRpc =
    process.env.VOYAGER_RPC_URL ??
    process.env.SOLANA_RPC_URL ??
    process.env.RPC_URL;
  if (envRpc) return envRpc;
  throw new Error(
    "Missing RPC endpoint. Pass --rpc <url> or set VOYAGER_RPC_URL / SOLANA_RPC_URL / RPC_URL.",
  );
}

async function discoverRaydium(
  connection: Connection,
  inputMint: PublicKey,
  outputMint: PublicKey,
) {
  const CPMM_PROGRAM_ID = new PublicKey(
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  );

  function readPubkey(buf: Buffer, offset: number): PublicKey {
    return new PublicKey(buf.subarray(offset, offset + 32));
  }

  async function findCpmPoolByMints(mintA: PublicKey, mintB: PublicKey) {
    const offToken0 = 168;
    const offToken1 = 200;
    const queries: { t0: PublicKey; t1: PublicKey }[] = [
      { t0: mintA, t1: mintB },
      { t0: mintB, t1: mintA },
    ];
    for (const q of queries) {
      const accs = await connection.getProgramAccounts(CPMM_PROGRAM_ID, {
        filters: [
          { memcmp: { offset: offToken0, bytes: q.t0.toBase58() } },
          { memcmp: { offset: offToken1, bytes: q.t1.toBase58() } },
        ],
      });
      if (accs.length) {
        const a = accs[0];
        const data = a.account.data as Buffer;
        const base = 8;
        const ammConfig = readPubkey(data, base + 0);
        const token0Vault = readPubkey(data, base + 32 * 2);
        const token1Vault = readPubkey(data, base + 32 * 3);
        const token0Mint = readPubkey(data, base + 32 * 5);
        const token1Mint = readPubkey(data, base + 32 * 6);
        const token0Program = readPubkey(data, base + 32 * 7);
        const token1Program = readPubkey(data, base + 32 * 8);
        const observationKey = readPubkey(data, base + 32 * 9);
        return {
          poolState: a.pubkey,
          ammConfig,
          token0Mint,
          token1Mint,
          token0Vault,
          token1Vault,
          token0Program,
          token1Program,
          observationKey,
          programId: CPMM_PROGRAM_ID,
        };
      }
    }
    return null;
  }

  async function getTokenAccountOwner(
    tokenAccount: PublicKey,
  ): Promise<PublicKey> {
    const info = await connection.getAccountInfo(tokenAccount);
    if (!info || !info.data || info.data.length < 64)
      throw new Error("Invalid token account for vault owner fetch");
    return new PublicKey((info.data as Buffer).subarray(32, 64));
  }

  const pool = await findCpmPoolByMints(inputMint, outputMint);
  if (!pool) throw new Error("Raydium CPMM pool not found for provided mints");

  const inputIsToken0 = pool.token0Mint.equals(inputMint);
  const inputVault = inputIsToken0 ? pool.token0Vault : pool.token1Vault;
  const authority = await getTokenAccountOwner(inputVault);

  return {
    programId: pool.programId.toBase58(),
    ammConfig: pool.ammConfig.toBase58(),
    poolState: pool.poolState.toBase58(),
    token0Mint: pool.token0Mint.toBase58(),
    token1Mint: pool.token1Mint.toBase58(),
    token0Vault: pool.token0Vault.toBase58(),
    token1Vault: pool.token1Vault.toBase58(),
    token0Program: pool.token0Program.toBase58(),
    token1Program: pool.token1Program.toBase58(),
    observationKey: pool.observationKey.toBase58(),
    authority: authority.toBase58(),
  };
}

function loadMeteoraSdk(): { DLMM: any; memoProgramId: string; programId: string } | null {
  try {
    const mod = requireCjs("@meteora-ag/dlmm/dist/index.js");
    const DLMMCtor = mod?.DLMM ?? mod?.default ?? mod;
    if (!DLMMCtor) return null;

    const memoProgram = mod?.MEMO_PROGRAM_ID ?? mod?.default?.MEMO_PROGRAM_ID;
    const memoProgramId =
      typeof memoProgram?.toBase58 === "function"
        ? memoProgram.toBase58()
        : DEFAULT_MEMO_PROGRAM;

    // Extract program ID from LBCLMM_PROGRAM_IDS
    const LBIDS = mod?.LBCLMM_PROGRAM_IDS ?? mod?.default?.LBCLMM_PROGRAM_IDS ?? {};
    const programId = LBIDS['mainnet-beta'] || LBIDS['mainnet'] || LBIDS['localhost'];
    if (!programId) {
      console.warn("Could not find Meteora program ID in LBCLMM_PROGRAM_IDS");
      return null;
    }

    return { DLMM: DLMMCtor, memoProgramId, programId };
  } catch (err) {
    return null;
  }
}

async function main() {
  // Single-command mode: always attempt supported DEXes.
  const outPath = argVal("--out", "voyager/environments/swap_idl_vars.json")!;
  const rpc = resolveRpcUrl();
  const cliMeteora = argVal("--meteora-lbpair");

  // Prepare output paths and optimistically load any previous file for caching
  const outAbs = path.isAbsolute(outPath)
    ? outPath
    : path.resolve(process.cwd(), outPath);
  const outDir = path.dirname(outAbs);
  // Silence noisy native binding warnings before importing heavy deps
  silenceBindingsWarnings();
  // Dynamic imports after filter so their internal startup logs get silenced if needed
  ({ Connection, PublicKey } = await import("@solana/web3.js"));
  ({ NATIVE_MINT } = await import("@solana/spl-token"));

  const connection = new Connection(rpc, "confirmed");

  // Default discovery mints (wSOL -> USDC)
  const inputMint = NATIVE_MINT;
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  // Built-in Meteora LbPair candidates (mainnet). If not found in your snapshot, we'll try to discover one.
  const meteoraLbPairCandidates: string[] = [
    ...(cliMeteora ? [cliMeteora] : []),
    "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR",
  ];

  // If hardcoded candidates fail, try to discover pools on-chain
  let shouldDiscoverPools = false;

  const result: any = {};

  // Raydium
  try {
    result.raydium = await discoverRaydium(connection, inputMint, outputMint);
    console.log("Discovered Raydium vars");
  } catch (e) {
    console.warn("Raydium discovery failed:", e);
  }

  const meteoraSdk = loadMeteoraSdk();

  if (!meteoraSdk) {
    throw new Error(
      "Meteora SDK unavailable; install @meteora-ag/dlmm in voyager/skill_runner to enable discovery",
    );
  }

  let lbPairFound: PublicKey | null = null;
  let lastError: unknown = null;

  // Retry logic: Meteora discovery sometimes fails initially but succeeds after retries
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1000;

  for (const cand of meteoraLbPairCandidates) {
    const pk = new PublicKey(cand);
    let retryCount = 0;

    while (retryCount < MAX_RETRIES && !lbPairFound) {
      try {
        const pool = await meteoraSdk.DLMM.create(connection, pk);
      const tokenXMintPk: any = pool.tokenX.publicKey;
      const tokenYMintPk: any = pool.tokenY.publicKey;
      const reserveXPk: any = pool.tokenX.reserve;
      const reserveYPk: any = pool.tokenY.reserve;
      const oraclePk: any = pool.lbPair.oracle;
      const swapYtoX = pool.tokenY.publicKey.equals(NATIVE_MINT)
        ? true
        : pool.tokenX.publicKey.equals(NATIVE_MINT)
          ? false
          : true;
      const binArrays = await pool.getBinArrayForSwap(swapYtoX, 6);
      const binArrayPubkeys = Array.from(
        new Set(
          binArrays
            .map((entry: any) => entry?.publicKey?.toBase58?.())
            .filter((x: string | undefined): x is string => Boolean(x)),
        ),
      );
      if (!binArrayPubkeys.length) {
        throw new Error(
          `No bin arrays returned for Meteora pool ${pk.toBase58()} (swapYtoX=${swapYtoX})`,
        );
      }

      result.meteora = {
        programId: pool.program.programId.toBase58(),
        lbPair: pk.toBase58(),
        tokenXMint: tokenXMintPk.toBase58(),
        tokenYMint: tokenYMintPk.toBase58(),
        reserveX: reserveXPk.toBase58(),
        reserveY: reserveYPk.toBase58(),
        oracle: oraclePk.toBase58(),
        memoProgram: meteoraSdk.memoProgramId,
        binArrays: binArrayPubkeys,
      };
      lbPairFound = pk;
      if (retryCount > 0) {
        console.log(`Discovered Meteora vars (succeeded after ${retryCount + 1} attempts)`);
      } else {
        console.log("Discovered Meteora vars");
      }
      break; // Exit retry loop on success
    } catch (inner) {
      lastError = inner;
      retryCount++;

      if (retryCount < MAX_RETRIES) {
        console.warn(
          `Meteora discovery attempt ${retryCount}/${MAX_RETRIES} failed for candidate ${cand}: ${
            inner instanceof Error ? inner.message : inner
          }. Retrying in ${RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.warn(
          `Meteora discovery failed for candidate ${cand} after ${MAX_RETRIES} attempts:`,
          inner instanceof Error ? inner.message : inner,
        );
      }
    }
    } // End while retry loop

    if (lbPairFound) break; // Exit candidate loop if found
  }

  if (!lbPairFound) {
    const lastErrMsg =
      lastError instanceof Error
        ? `${lastError.name}: ${lastError.message}`
        : JSON.stringify(lastError);
    console.warn(
      `Meteora discovery failed for all hardcoded candidates. Last error: ${lastErrMsg}`,
    );
    console.log("Attempting to discover Meteora pools on-chain...");

    // Try to find any Meteora pool via getProgramAccounts
    try {
      const meteoraProgramId = new PublicKey(meteoraSdk.programId);
      const { getLbPairDecoder } = await import("./sdk/dlmm/accounts/lbPair");
      const decoder = getLbPairDecoder();

      // Find LbPair accounts (filter by reasonable size)
      const lbPairAccounts = await connection.getProgramAccounts(meteoraProgramId, {
        filters: [
          { dataSize: 1464 }, // LbPair account size (may need adjustment)
        ],
      });

      console.log(`Found ${lbPairAccounts.length} potential Meteora LbPair accounts`);

      // Try the first few that decode successfully
      for (const acc of lbPairAccounts.slice(0, 5)) {
        try {
          const lb = decoder.decode(new Uint8Array(acc.account.data));
          const tokenXMint = new PublicKey(lb.tokenXMint);
          const tokenYMint = new PublicKey(lb.tokenYMint);

          // Check if this pool involves our target mints
          if (
            (tokenXMint.equals(inputMint) && tokenYMint.equals(outputMint)) ||
            (tokenXMint.equals(outputMint) && tokenYMint.equals(inputMint))
          ) {
            console.log(`Found matching pool: ${acc.pubkey.toBase58()}`);
            meteoraLbPairCandidates.push(acc.pubkey.toBase58());
            shouldDiscoverPools = true;
            break;
          }
        } catch (decodeErr) {
          // Skip accounts that don't decode properly
          continue;
        }
      }

      // Retry with discovered pool
      if (shouldDiscoverPools) {
        for (const cand of meteoraLbPairCandidates.slice(-1)) {
          const pk = new PublicKey(cand);
          try {
            const pool = await meteoraSdk.DLMM.create(connection, pk);
            const swapYtoX = pool.tokenY.publicKey.equals(NATIVE_MINT);
            const binArrays = await pool.getBinArrayForSwap(swapYtoX, 6);
            const binArrayPubkeys = Array.from(
              new Set(
                binArrays
                  .map((entry: any) => entry?.publicKey?.toBase58?.())
                  .filter((x: string | undefined): x is string => Boolean(x)),
              ),
            );

            result.meteora = {
              programId: pool.program.programId.toBase58(),
              lbPair: pk.toBase58(),
              tokenXMint: pool.tokenX.publicKey.toBase58(),
              tokenYMint: pool.tokenY.publicKey.toBase58(),
              reserveX: pool.tokenX.reserve.toBase58(),
              reserveY: pool.tokenY.reserve.toBase58(),
              oracle: pool.lbPair.oracle.toBase58(),
              memoProgram: meteoraSdk.memoProgramId,
              binArrays: binArrayPubkeys,
            };
            lbPairFound = pk;
            console.log("Discovered Meteora vars from on-chain discovery");
            break;
          } catch (retryErr) {
            console.warn(`Retry failed for discovered pool ${cand}:`, retryErr);
          }
        }
      }
    } catch (discoveryErr) {
      console.warn("On-chain Meteora pool discovery failed:", discoveryErr);
    }
  }

  if (!lbPairFound) {
    console.warn("Continuing without Meteora. Only Raydium will be available.");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(result, null, 2));
  console.log("Wrote", outAbs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
