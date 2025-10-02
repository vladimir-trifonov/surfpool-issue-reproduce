# Surfpool Crash Reproduction

Standalone minimal reproduction of Surfpool crash when executing 5 transactions in sequence.

## Prerequisites

```bash
# Install Surfpool (surfpool 0.10.6)
brew install txtx/taps/surfpool

# Install Bun (for TypeScript execution)
curl -fsSL https://bun.sh/install | bash

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Bun dependencies
cd runner/
bun install
cd ..

# Ensure you have a Solana keypair at ~/.config/solana/id.json
```

## Start Surfpool with Maximum Debug Output

```bash
# Kill any existing instances
pkill -9 surfpool || killall -9 surfpool

# Start with debug logging and no TUI
RUST_LOG=debug,solana=debug surfpool start \
  -u https://api.mainnet-beta.solana.com \
  -p 8899 \
  --no-tui \
  --log-level debug

# Or save logs to file
RUST_LOG=debug surfpool start \
  -u https://api.mainnet-beta.solana.com \
  -p 8899 \
  --no-tui \
  --log-level debug \
  > surfpool.log 2>&1 &
```

## Run Reproduction

```bash
uv run --with solana --with solders python replay.py
```

Expected outcome:
- TX1: ✅ Successful tx
- TX2: ❌ Expected build failure
- TX3: ✅ Successful tx
- TX4: ✅ Successful tx
- TX5: 💥 Crashes Surfpool with panic:
  ```
  thread '<unnamed>' panicked at crates/rpc-responses/src/lib.rs:363:84:
  called `Result::unwrap()` on an `Err` value: Error("missing field `data`", line: 0, column: 0)
  ```

## Stop Surfpool

```bash
pkill -9 surfpool || killall -9 surfpool
```

## Structure

- `replay.py` - Replays 5 transactions from conversation log
- `transactions/` - 5 TypeScript transaction builders extracted from LLM output
- `runner/` - Bun runtime with IDL SDKs (dlmm, raydium_cp) and dependencies
