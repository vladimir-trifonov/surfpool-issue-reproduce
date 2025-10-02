#!/usr/bin/env python3
"""
Standalone reproduction script for Surfpool crash issue.
Replays 5 transactions from conversation log in exact order.
"""

import asyncio
import base64
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional

from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solders.message import to_bytes_versioned

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class TransactionReplayer:
    def __init__(self, rpc_url: str = "http://localhost:8899"):
        self.rpc_url = rpc_url
        self.client = None
        self.agent = self._load_keypair()
        self.timeout = 30000  # 30 seconds
        self.delay = 2.0  # 2 second delay between transactions

    def _load_keypair(self) -> Keypair:
        """Load keypair from default Solana CLI location."""
        keypair_path = Path.home() / ".config" / "solana" / "id.json"
        if not keypair_path.exists():
            raise FileNotFoundError(f"Keypair not found at {keypair_path}")

        with open(keypair_path, 'r') as f:
            keypair_data = json.load(f)

        keypair = Keypair.from_bytes(bytes(keypair_data))
        logging.info(f"Loaded keypair: {keypair.pubkey()}")
        return keypair

    async def initialize(self):
        """Initialize RPC client."""
        self.client = AsyncClient(self.rpc_url)

        # Test connection
        block_height = await self.client.get_block_height()
        if block_height and block_height.value is not None:
            logging.info(f"✅ Connected to Surfpool (block height: {block_height.value})")
        else:
            raise ValueError("Failed to connect to Surfpool")

    async def get_blockhash(self) -> str:
        """Fetch latest blockhash."""
        response = await self.client.get_latest_blockhash()
        if response and response.value:
            blockhash = str(response.value.blockhash)
            logging.info(f"Fetched blockhash: {blockhash[:16]}...")
            return blockhash
        raise ValueError("Failed to fetch blockhash")

    def _generate_dex_env(self, dex_env_file: Path):
        """Generate dex_env.ts by discovering DEX pools using build_dex_env.ts."""
        import shutil
        import tempfile

        runner_dir = Path(__file__).parent / "runner"
        build_script = runner_dir / "build_dex_env.ts"

        # Check if build_dex_env.ts exists
        if not build_script.exists():
            raise FileNotFoundError(f"build_dex_env.ts not found at {build_script}")

        # Find bun executable
        bun_path = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")

        # Use temporary file for intermediate JSON output
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, dir=runner_dir) as tmp:
            tmp_json_path = Path(tmp.name)

        try:
            # Run build_dex_env.ts to discover DEX pools
            logging.info("Discovering DEX pools using build_dex_env.ts...")
            result = subprocess.run(
                [bun_path, "build_dex_env.ts", "--out", str(tmp_json_path), "--rpc", self.rpc_url],
                cwd=runner_dir,
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                logging.error(f"build_dex_env.ts failed: {result.stderr}")
                raise RuntimeError(f"Failed to discover DEX pools: {result.stderr}")

            logging.info(result.stdout)

            # Load the discovered DEX vars
            if not tmp_json_path.exists():
                raise FileNotFoundError(f"DEX vars JSON not created at {tmp_json_path}")

            with open(tmp_json_path, 'r') as f:
                dex_vars = json.load(f)

            raydium = dex_vars.get("raydium", {})
            meteora = dex_vars.get("meteora", {})

            # Generate dex_env.ts from discovered vars
            content = (
                f"export const RAYDIUM = {json.dumps(raydium, indent=2)} as const;\n"
                f"export const METEORA = {json.dumps(meteora, indent=2)} as const;\n"
            )

            with open(dex_env_file, 'w') as f:
                f.write(content)

            logging.info(f"Generated {dex_env_file}")

        except subprocess.TimeoutExpired:
            raise RuntimeError("DEX pool discovery timed out")
        except Exception as e:
            raise RuntimeError(f"Failed to run build_dex_env.ts: {e}")
        finally:
            # Clean up temporary JSON file
            if tmp_json_path.exists():
                tmp_json_path.unlink()

    def build_transaction(self, tx_file: Path, blockhash: str) -> Optional[str]:
        """Build transaction by executing TypeScript file with Bun."""
        runner_dir = Path(__file__).parent / "runner"

        # Generate dex_env.ts if it doesn't exist
        dex_env_file = runner_dir / "dex_env.ts"
        if not dex_env_file.exists():
            self._generate_dex_env(dex_env_file)

        # Copy transaction to runner directory as code.ts
        code_file = runner_dir / "code.ts"
        with open(tx_file, 'r') as src, open(code_file, 'w') as dst:
            dst.write(src.read())

        # Find bun executable
        import shutil
        bun_path = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")

        try:
            result = subprocess.run(
                [bun_path, "runTransaction.ts", "code.ts", str(self.timeout), blockhash],
                cwd=runner_dir,
                capture_output=True,
                text=True,
                timeout=self.timeout / 1000 + 5,
                env={"PAYER_PUBKEY": str(self.agent.pubkey())}
            )

            output = json.loads(result.stdout)
            if output.get("success"):
                return output["serialized_tx"]
            else:
                logging.error(f"Build failed: {output.get('error')}")
                logging.error(f"Details: {output.get('details')}")
                return None

        except subprocess.TimeoutExpired:
            logging.error(f"Build timed out for {tx_file.name}")
            return None
        except Exception as e:
            logging.error(f"Build error for {tx_file.name}: {e}")
            return None

    async def send_transaction(self, serialized_tx: str, tx_name: str) -> Dict:
        """Send transaction to Surfpool and wait for confirmation."""
        result = {"tx_name": tx_name, "success": False, "signature": None, "error": None}

        try:
            # Decode and sign transaction
            tx_bytes = base64.b64decode(serialized_tx)
            tx = VersionedTransaction.from_bytes(tx_bytes)

            msg_bytes = to_bytes_versioned(tx.message)
            signature = self.agent.sign_message(msg_bytes)
            signed_tx = VersionedTransaction.populate(tx.message, [signature])

            # Send transaction
            start = time.time()
            response = await self.client.send_transaction(signed_tx)
            rpc_time = time.time() - start

            if response and response.value:
                sig = str(response.value)
                result["signature"] = sig
                logging.info(f"Transaction sent in {rpc_time:.3f}s: {sig[:16]}...")

                # Wait for confirmation
                confirmation = await self.client.confirm_transaction(response.value)

                if confirmation and confirmation.value:
                    if confirmation.value[0].err is None:
                        result["success"] = True
                        logging.info(f"✅ {tx_name} confirmed")
                    else:
                        result["error"] = f"Failed: {confirmation.value[0].err}"
                        logging.error(f"❌ {tx_name} failed: {confirmation.value[0].err}")
                else:
                    result["error"] = "No confirmation received"
                    logging.error(f"❌ {tx_name}: No confirmation")
            else:
                result["error"] = "No signature returned"
                logging.error(f"❌ {tx_name}: No signature")

        except Exception as e:
            result["error"] = str(e)
            logging.error(f"❌ {tx_name} exception: {e}")

        return result

    async def replay_all(self):
        """Replay all transactions in order."""
        tx_dir = Path(__file__).parent / "transactions"
        tx_files = sorted(tx_dir.glob("tx_*.ts"))

        logging.info(f"Found {len(tx_files)} transactions to replay\n")

        results = []
        for i, tx_file in enumerate(tx_files, 1):
            logging.info("=" * 60)
            logging.info(f"Transaction {i}/{len(tx_files)}: {tx_file.name}")
            logging.info("=" * 60)

            # Get blockhash
            blockhash = await self.get_blockhash()

            # Build transaction
            serialized_tx = self.build_transaction(tx_file, blockhash)
            if not serialized_tx:
                results.append({"tx_name": tx_file.name, "success": False, "error": "Build failed"})
                continue

            # Send transaction
            result = await self.send_transaction(serialized_tx, tx_file.name)
            results.append(result)

            # Delay between transactions
            if i < len(tx_files):
                logging.info(f"Waiting {self.delay}s before next transaction...\n")
                await asyncio.sleep(self.delay)

        # Summary
        logging.info("=" * 60)
        logging.info("REPLAY SUMMARY")
        logging.info("=" * 60)
        successful = sum(1 for r in results if r["success"])
        logging.info(f"Total: {len(results)}, Successful: {successful}, Failed: {len(results) - successful}")

        failed = [r for r in results if not r["success"]]
        if failed:
            logging.info("\nFailed transactions:")
            for r in failed:
                logging.info(f"  - {r['tx_name']}: {r.get('error', 'Unknown error')}")

        # Save results
        results_file = Path(__file__).parent / "replay_results.json"
        with open(results_file, 'w') as f:
            json.dump(results, f, indent=2)
        logging.info(f"\nResults saved to: {results_file}")

    async def close(self):
        """Close RPC client."""
        if self.client:
            await self.client.close()

async def main():
    replayer = TransactionReplayer()
    try:
        await replayer.initialize()
        await replayer.replay_all()
    finally:
        await replayer.close()

if __name__ == "__main__":
    asyncio.run(main())
