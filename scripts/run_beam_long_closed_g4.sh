#!/usr/bin/env bash
# ==============================================================================
# Hermetic Single-Box Closed-System Official ICLR 2026 BEAM Higher-Context Runner
# Splits: 10M (200/200 Qs), 1M (700/700 Qs), 500K (700/700 Qs)
# Target Hardware: Google Colab Pro G4 (96GB NVIDIA RTX PRO 6000 Blackwell)
#
# Guarantees:
#   1. Zero Cloud LLM APIs (GEMINI_API_KEY unset; all endpoints strictly 127.0.0.1:11434).
#   2. Zero Homelab LAN / Zero Pre-Cached Vectors (downloads official Hugging Face Parquet
#      shards fresh inside G4, verifies Git-LFS SHA-256 digests, and computes all
#      snowflake-arctic-embed2 embeddings from scratch on Blackwell).
#   3. Zero Self-Grading Bias: Co-locates 4 distinct open-weights models simultaneously
#      in 97.9 GB Blackwell VRAM (OLLAMA_MAX_LOADED_MODELS=4, 100% GPU):
#        - Embedder : snowflake-arctic-embed2:latest (~0.66 GB, 8,192 ctx, 1024d)
#        - Reader   : gpt-oss:120b (~64 GB, OpenAI 117B MXFP4 MoE)
#        - Judge 1  : qwen2.5:32b (~21 GB, Alibaba Qwen 32B Dense Primary Referee)
#        - Judge 2  : hermes3:latest (~5.5 GB, Nous Hermes 3 Llama-3.1 8B Continuity)
#   4. Per-Split Checkpointing: Executes each split in its own isolated `colab exec`
#      stage (`10M` -> `1M` -> `500K` by default), immediately downloading and running
#      5-gate `verify_zero_leakage_long.js` on local disk before advancing.
#   5. Guaranteed EXIT trap tears down colab-g4 so zero Compute Units leak.
# ==============================================================================
set -euo pipefail

SESSION="colab-g4"
COLAB_BIN="${COLAB_BIN:-$(command -v colab 2>/dev/null || echo "${HOME}/.local/bin/colab")}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SPLITS_STR="${BEAM_LONG_SPLITS:-10M 1M 500K}"
read -r -a SPLITS <<< "$SPLITS_STR"

cleanup() {
  echo ""
  echo "[beam-long-g4] Executing mandatory EXIT teardown so zero Compute Units leak..."
  systemctl --user stop colab-g4-tunnel 2>/dev/null || true
  pkill -f "ssh .*colab-g4" 2>/dev/null || true
  "$COLAB_BIN" stop -s "$SESSION" 2>/dev/null || true
  for s in $("$COLAB_BIN" sessions 2>/dev/null | sed -n 's/^\[//;s/\].*//p'); do
    if [ -n "$s" ] && [ "$s" != "colab" ]; then
      echo "[beam-long-g4] Stopping active Colab session '$s'..."
      "$COLAB_BIN" stop -s "$s" 2>/dev/null || true
    fi
  done
  "$COLAB_BIN" sessions || true
  "$COLAB_BIN" usage || true
}
trap cleanup EXIT INT TERM

echo "=============================================================================="
echo "🔒 STARTING HERMETIC CLOSED-SYSTEM HIGHER-CONTEXT BEAM (${SPLITS[*]}) ON COLAB G4"
echo "=============================================================================="
"$COLAB_BIN" usage

echo "[beam-long-g4] Staging clean-room source bundle (/tmp/beam-long-closed-bundle.tar.gz)..."
STAGE_DIR="/tmp/beam-long-closed-stage-$$"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/krusch-context-mcp/benchmarks"

cp "$MCP_ROOT/package.json" "$MCP_ROOT/package-lock.json" "$STAGE_DIR/krusch-context-mcp/"
cp -r "$MCP_ROOT/src" "$MCP_ROOT/scripts" "$MCP_ROOT/db" "$MCP_ROOT/bin" "$MCP_ROOT/templates" "$MCP_ROOT/tests" "$STAGE_DIR/krusch-context-mcp/"
cp "$MCP_ROOT/benchmarks/verify_zero_leakage.js" "$MCP_ROOT/benchmarks/verify_zero_leakage_long.js" "$STAGE_DIR/krusch-context-mcp/benchmarks/"
cp "$MCP_ROOT/README.md" "$MCP_ROOT/CHANGELOG.md" "$MCP_ROOT/LICENSE" "$STAGE_DIR/krusch-context-mcp/"
mkdir -p "$STAGE_DIR/krusch-context-mcp/docs"
cp "$MCP_ROOT/docs/"*.md "$STAGE_DIR/krusch-context-mcp/docs/" 2>/dev/null || true
if [ -d "$MCP_ROOT/evals" ]; then
  cp -r "$MCP_ROOT/evals" "$STAGE_DIR/krusch-context-mcp/"
fi

tar -czf /tmp/beam-long-closed-bundle.tar.gz -C "$STAGE_DIR" .
rm -rf "$STAGE_DIR"
ls -lh /tmp/beam-long-closed-bundle.tar.gz

STATUS_OUT=$("$COLAB_BIN" status -s "$SESSION" 2>&1 || true)
if echo "$STATUS_OUT" | grep -qi "not found" || ! echo "$STATUS_OUT" | grep -qi "colab-g4"; then
  echo "[beam-long-g4] Allocating 96GB NVIDIA RTX PRO 6000 Blackwell (--gpu G4)..."
  "$COLAB_BIN" new -s "$SESSION" --gpu G4
  sleep 3
fi

echo "[beam-long-g4] Uploading clean-room bundle to /content/beam-long-closed-bundle.tar.gz..."
UPLOAD_OK=0
for attempt in 1 2 3 4 5; do
  if "$COLAB_BIN" upload -s "$SESSION" /tmp/beam-long-closed-bundle.tar.gz /content/beam-long-closed-bundle.tar.gz; then
    UPLOAD_OK=1
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "[beam-long-g4] Colab proxy TLS endpoint unhealthy; recycling G4 session..."
    "$COLAB_BIN" stop -s "$SESSION" >/dev/null 2>&1 || true
    sleep 2
    "$COLAB_BIN" new -s "$SESSION" --gpu G4
    sleep 5
  else
    echo "[beam-long-g4] Retrying upload (${attempt}/5)..."
    sleep 5
  fi
done
if [ "$UPLOAD_OK" -ne 1 ]; then
  echo "[beam-long-g4] ERROR: Failed to upload bundle to Colab G4."
  exit 1
fi

echo "[beam-long-g4] Stage 0: Provisioning Clean-Room Node 22 + Isolated Loopback Ollama + 4 Co-Located Models..."
"$COLAB_BIN" exec -s "$SESSION" --timeout 3600 << 'PYEOF'
import json, os, select, shutil, subprocess, sys, time, urllib.request

def run_stream(cmd_args, cwd=None, env=None, shell=False):
    proc = subprocess.Popen(
        cmd_args, cwd=cwd, env=env, shell=shell,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    fd = proc.stdout.fileno()
    t0 = time.monotonic()
    while True:
        rlist, _, _ = select.select([fd], [], [], 20.0)
        if rlist:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            sys.stdout.write(chunk.decode("utf-8", errors="replace").replace("\r", "\n"))
            sys.stdout.flush()
        else:
            if proc.poll() is not None:
                break
            elapsed = int(time.monotonic() - t0)
            sys.stdout.write(f"[beam-long-g4] setup heartbeat ({elapsed}s elapsed)...\n")
            sys.stdout.flush()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"Command {cmd_args} exited with code {rc}")

run_stream(
    "rm -rf /root/beam-cleanroom /tmp/beam_* /content/beam_*_audit_log.json && "
    "mkdir -p /root/beam-cleanroom && "
    "tar -xzf /content/beam-long-closed-bundle.tar.gz -C /root/beam-cleanroom",
    shell=True,
)

need_node22 = True
if shutil.which("node"):
    ver_out = subprocess.check_output(["node", "-v"], text=True).strip()
    if int(ver_out.lstrip("v").split(".")[0]) >= 22:
        need_node22 = False
        print(f"[beam-long-g4] Existing Node.js {ver_out} satisfies >=22.", flush=True)

if need_node22:
    print("[beam-long-g4] Installing official Node.js v22 LTS binary...", flush=True)
    run_stream(
        "NODE_TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v22\\.[0-9]+\\.[0-9]+-linux-x64\\.tar\\.xz' | head -n1) && "
        "curl -fsSL \"https://nodejs.org/dist/latest-v22.x/${NODE_TARBALL}\" -o /tmp/node22.tar.xz && "
        "rm -rf /usr/local/node22 && mkdir -p /usr/local/node22 && "
        "tar -xJf /tmp/node22.tar.xz -C /usr/local/node22 --strip-components=1 && "
        "ln -sf /usr/local/node22/bin/node /usr/local/bin/node && "
        "ln -sf /usr/local/node22/bin/npm /usr/local/bin/npm && "
        "ln -sf /usr/local/node22/bin/npx /usr/local/bin/npx && "
        "rm -f /tmp/node22.tar.xz",
        shell=True,
    )

os.environ["PATH"] = "/usr/local/node22/bin:/usr/local/bin:" + os.environ.get("PATH", "")
run_stream("python3 -c 'import pyarrow.parquet' 2>/dev/null || pip install -q pyarrow", shell=True)
run_stream("python3 -c 'import pyarrow.parquet; print(\"pyarrow verified\")'", shell=True)
run_stream("node -v && npm -v", shell=True)
run_stream("npm ci --no-audit --no-fund", cwd="/root/beam-cleanroom/krusch-context-mcp", shell=True)
run_stream("CI=true node --test --test-concurrency=1 tests/*.test.js", cwd="/root/beam-cleanroom/krusch-context-mcp", shell=True)

if not shutil.which("ollama"):
    run_stream("apt-get update -qq || true", shell=True)
    run_stream("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=60 zstd pciutils gcc libgomp1 && curl -fsSL https://ollama.com/install.sh | sh", shell=True)

subprocess.run("pkill -x ollama 2>/dev/null || true", shell=True)
time.sleep(1)
ollama_env = os.environ.copy()
ollama_env["OLLAMA_HOST"] = "127.0.0.1:11434"
ollama_env["OLLAMA_FLASH_ATTENTION"] = "1"
ollama_env["OLLAMA_KV_CACHE_TYPE"] = "q8_0"
ollama_env["OLLAMA_KEEP_ALIVE"] = "-1"
ollama_env["OLLAMA_MAX_LOADED_MODELS"] = "4"
ollama_env["OLLAMA_NUM_PARALLEL"] = "3"
log_fh = open("/tmp/ollama_beam_long.log", "w")
subprocess.Popen(["ollama", "serve"], env=ollama_env, stdin=subprocess.DEVNULL, stdout=log_fh, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
for _ in range(30):
    try:
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2)
        break
    except Exception:
        time.sleep(1)

for mdl in ["snowflake-arctic-embed2:latest", "gpt-oss:120b", "qwen2.5:32b", "hermes3:latest"]:
    print(f"[beam-long-g4] Pulling {mdl}...", flush=True)
    run_stream(["ollama", "pull", mdl])

gpu_info = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], text=True).strip()
ollama_tags = json.loads(urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=10).read().decode("utf-8"))
model_digests = {m["name"]: m.get("digest", "") for m in ollama_tags.get("models", [])}

embed_warm_req = urllib.request.Request(
    "http://127.0.0.1:11434/api/embed",
    data=json.dumps({
        "model": "snowflake-arctic-embed2:latest",
        "input": ["query: warm 8k context"],
        "truncate": True,
        "keep_alive": -1,
        "options": {"num_ctx": 8192},
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(embed_warm_req, timeout=120).read()

for mdl, ctx in [("gpt-oss:120b", 16384), ("qwen2.5:32b", 4096), ("hermes3:latest", 4096)]:
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps({"model": mdl, "prompt": "ok", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=180).read()

run_stream(["ollama", "ps"])
closed_meta = {
    "execution_mode": "Hermetic Single-Box Closed System (Zero External LLM APIs, Zero LAN, Fresh Cold-Room Embeddings)",
    "gpu_hardware": gpu_info,
    "ollama_bind_host": "127.0.0.1:11434",
    "gemini_api_key_present": False,
    "embed_model": "snowflake-arctic-embed2:latest",
    "embed_num_ctx": 8192,
    "ollama_model_sha256_digests": model_digests,
}
with open("/tmp/beam_long_closed_meta.json", "w", encoding="utf-8") as mfh:
    json.dump(closed_meta, mfh)
print("=== STAGE 0 PROVISIONING COMPLETE ===", flush=True)
PYEOF

rm -f /tmp/beam_long_closed_meta_host.json
if ! "$COLAB_BIN" download -s "$SESSION" /tmp/beam_long_closed_meta.json /tmp/beam_long_closed_meta_host.json; then
  echo "[beam-long-g4] ERROR: Stage 0 provisioning failed inside Colab G4; aborting immediately."
  exit 1
fi

mkdir -p "$MCP_ROOT/benchmarks/g4_closed_system"

for SPLIT in "${SPLITS[@]}"; do
  SPLIT_LOWER=$(echo "$SPLIT" | tr '[:upper:]' '[:lower:]')
  echo ""
  echo "=============================================================================="
  echo "🚀 RUNNING FULL CLOSED-SYSTEM OFFICIAL BEAM ${SPLIT} SPLIT ON COLAB G4"
  echo "=============================================================================="

  "$COLAB_BIN" exec -s "$SESSION" --timeout 14400 << PYEOF
import json, os, select, shutil, subprocess, sys, time

os.environ["PATH"] = "/usr/local/node22/bin:/usr/local/bin:" + os.environ.get("PATH", "")
split = "${SPLIT}"
split_lower = "${SPLIT_LOWER}"

def run_stream(cmd_args, cwd=None, env=None, shell=False):
    proc = subprocess.Popen(
        cmd_args, cwd=cwd, env=env, shell=shell,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    fd = proc.stdout.fileno()
    t0 = time.monotonic()
    while True:
        rlist, _, _ = select.select([fd], [], [], 20.0)
        if rlist:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            sys.stdout.write(chunk.decode("utf-8", errors="replace").replace("\r", "\n"))
            sys.stdout.flush()
        else:
            if proc.poll() is not None:
                break
            elapsed = int(time.monotonic() - t0)
            sys.stdout.write(f"[beam-long-g4:{split}] heartbeat ({elapsed}s elapsed)...\n")
            sys.stdout.flush()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"Command {cmd_args} exited with code {rc}")

with open("/tmp/beam_long_closed_meta.json", "r", encoding="utf-8") as mfh:
    closed_meta = json.load(mfh)

# Clean any prior split caches so disk stays spacious and embeddings are 100% cold-room fresh
run_stream(f"rm -rf /tmp/beam_{split_lower}_embed_cache_* /tmp/beam_{split_lower}_official.jsonl*", shell=True)

bench_env = os.environ.copy()
bench_env.pop("GEMINI_API_KEY", None)
bench_env["GEMINI_API_KEY"] = ""
bench_env["EMBED_MODEL"] = "snowflake-arctic-embed2:latest"
bench_env["OLLAMA_EMBED_NUM_CTX"] = "8192"
bench_env["OLLAMA_EMBED_URL"] = "http://127.0.0.1:11434/api/embed"
bench_env["OLLAMA_READER_URL"] = "http://127.0.0.1:11434/api/chat"
bench_env["OLLAMA_JUDGE_URL"] = "http://127.0.0.1:11434/api/chat"
bench_env["READER_MODEL"] = "gpt-oss:120b"
bench_env["OLLAMA_READER_THINK"] = "low"
bench_env["OLLAMA_READER_NUM_PREDICT"] = "2560"
bench_env["OLLAMA_JUDGE_MODEL"] = "qwen2.5:32b"
bench_env["OLLAMA_SECONDARY_JUDGE_MODEL"] = "hermes3:latest"
bench_env["OLLAMA_JUDGE_NUM_CTX"] = "4096"
bench_env["BEAM_JUDGE_CONCURRENCY"] = "3"
bench_env["BEAM_CLOSED_SYSTEM_META"] = json.dumps(closed_meta)

run_stream(
    [
        "node", "scripts/benchmark_official_beam_long.js",
        f"--split={split}",
        "--full-judge",
        "--no-embed-cache",
        f"--audit-log-out=/content/beam_{split_lower}_audit_log.json",
    ],
    cwd="/root/beam-cleanroom/krusch-context-mcp",
    env=bench_env,
)
run_stream(
    [
        "node", "benchmarks/verify_zero_leakage_long.js",
        f"--split={split}",
        f"--audit-log=/content/beam_{split_lower}_audit_log.json",
    ],
    cwd="/root/beam-cleanroom/krusch-context-mcp",
    env=bench_env,
)

# Reclaim raw Parquet/NDJSON disk space after verification inside G4 before next split
run_stream(f"rm -rf /tmp/beam_parquet/* /tmp/beam_{split_lower}_official.jsonl* /tmp/beam_{split_lower}_embed_cache_*", shell=True)
print(f"=== SPLIT {split} COMPLETE INSIDE G4 ===", flush=True)
PYEOF

  echo "[beam-long-g4] Checkpointing ${SPLIT} audit log onto local disk..."
  DL_OK=0
  for attempt in 1 2 3 4 5; do
    if "$COLAB_BIN" download -s "$SESSION" "/content/beam_${SPLIT_LOWER}_audit_log.json" "/tmp/beam_${SPLIT_LOWER}_g4_audit_log.json"; then
      DL_OK=1
      cp "/tmp/beam_${SPLIT_LOWER}_g4_audit_log.json" "$MCP_ROOT/benchmarks/g4_closed_system/beam_${SPLIT_LOWER}_audit_log.json"
      cp "/tmp/beam_${SPLIT_LOWER}_g4_audit_log.json" "$MCP_ROOT/benchmarks/beam_${SPLIT_LOWER}_audit_log.json"
      break
    fi
    sleep 4
  done
  if [ "$DL_OK" -ne 1 ]; then
    echo "[beam-long-g4] ERROR: Failed to download /content/beam_${SPLIT_LOWER}_audit_log.json"
    exit 1
  fi

  echo "[beam-long-g4] Running local 5-gate zero-leakage verification for ${SPLIT}..."
  (cd "$MCP_ROOT" && node benchmarks/verify_zero_leakage_long.js "--split=${SPLIT}" "--audit-log=benchmarks/beam_${SPLIT_LOWER}_audit_log.json")
done

echo "[beam-long-g4] Re-verifying original locked 100K zero-leakage gates (npm run bench:beam:verify)..."
(cd "$MCP_ROOT" && npm run bench:beam:verify)
echo "🎉 ALL HIGHER-CONTEXT OFFICIAL BEAM SPLITS (${SPLITS[*]}) COMPLETED AND VERIFIED!"
