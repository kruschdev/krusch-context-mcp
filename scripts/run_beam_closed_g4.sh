#!/usr/bin/env bash
# ==============================================================================
# Hermetic Single-Box Closed-System Official ICLR 2026 BEAM 100K Benchmark Runner
# Target Hardware: Google Colab Pro G4 (96GB NVIDIA RTX PRO 6000 Blackwell)
#
# Guarantees:
#   1. Zero Cloud LLM APIs (GEMINI_API_KEY unset; all endpoints strictly 127.0.0.1:11434).
#   2. Zero Homelab LAN / Zero Pre-Cached Vectors (downloads Mohammadta/BEAM fresh
#      from Hugging Face and computes all 3,266 bge-large embeddings from scratch).
#   3. Zero Self-Grading Bias: Co-locates 4 distinct open-weights models simultaneously
#      in 97.9 GB Blackwell VRAM (OLLAMA_MAX_LOADED_MODELS=4, 100% GPU):
#        - Embedder : bge-large:latest (~0.7 GB, BAAI BERT)
#        - Reader   : gpt-oss:120b (~67 GB, OpenAI 117B MXFP4 MoE)
#        - Judge 1  : qwen2.5:32b (~21.5 GB, Alibaba Qwen 32B Dense Primary Referee)
#        - Judge 2  : hermes3:latest (~5.5 GB, Nous Hermes 3 Llama-3.1 8B Continuity)
#   4. Executes full n=400/400 E2E evaluation on unmodified stock gpt-oss:120b first,
#      runs 5-stage verify_zero_leakage.js inside the G4 VM, then runs an in-place
#      GGUF fusion A/B test of krush420/gpt-oss-120b-sre-lora (auto-promoting to
#      400/400 only if it beats stock gpt-oss:120b on the n=20 stratified gate).
#   5. Guaranteed EXIT trap tears down colab-g4 so zero Compute Units leak.
# ==============================================================================
set -euo pipefail

SESSION="colab-g4"
COLAB_BIN="${COLAB_BIN:-$(command -v colab 2>/dev/null || echo "${HOME}/.local/bin/colab")}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOMELAB_ROOT="$(cd "${MCP_ROOT}/../.." && pwd)"
LORA_ADAPTER_GGUF="${LORA_ADAPTER_GGUF:-${HOMELAB_ROOT}/projects/jean-sre/models/jean-gpt-oss-120b-sre-lora/adapter.gguf}"
FUSE_SCRIPT="${FUSE_SCRIPT:-${HOMELAB_ROOT}/projects/jean-sre/scripts/fuse_lora_into_gguf.py}"

cleanup() {
  echo ""
  echo "[beam-g4] Executing mandatory EXIT teardown so zero Compute Units leak..."
  systemctl --user stop colab-g4-tunnel 2>/dev/null || true
  pkill -f "ssh .*colab-g4" 2>/dev/null || true
  "$COLAB_BIN" stop -s "$SESSION" 2>/dev/null || true
  for s in $("$COLAB_BIN" sessions 2>/dev/null | sed -n 's/^\[//;s/\].*//p'); do
    if [ -n "$s" ] && [ "$s" != "colab" ]; then
      echo "[beam-g4] Stopping active Colab session '$s'..."
      "$COLAB_BIN" stop -s "$s" 2>/dev/null || true
    fi
  done
  "$COLAB_BIN" sessions || true
  "$COLAB_BIN" usage || true
}
trap cleanup EXIT INT TERM

echo "=============================================================================="
echo "🔒 STARTING HERMETIC CLOSED-SYSTEM BEAM 100K FULL-SPLIT (n=400/400) ON COLAB G4"
echo "=============================================================================="
"$COLAB_BIN" usage

echo "[beam-g4] Staging clean-room source bundle (/tmp/beam-closed-bundle.tar.gz)..."
STAGE_DIR="/tmp/beam-closed-stage-$$"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/krusch-context-mcp/benchmarks" "$STAGE_DIR/lora"

cp "$MCP_ROOT/package.json" "$MCP_ROOT/package-lock.json" "$STAGE_DIR/krusch-context-mcp/"
cp -r "$MCP_ROOT/src" "$MCP_ROOT/scripts" "$MCP_ROOT/db" "$MCP_ROOT/bin" "$MCP_ROOT/templates" "$MCP_ROOT/tests" "$STAGE_DIR/krusch-context-mcp/"
cp "$MCP_ROOT/benchmarks/verify_zero_leakage.js" "$STAGE_DIR/krusch-context-mcp/benchmarks/"
cp "$MCP_ROOT/README.md" "$MCP_ROOT/CHANGELOG.md" "$MCP_ROOT/LICENSE" "$STAGE_DIR/krusch-context-mcp/"
mkdir -p "$STAGE_DIR/krusch-context-mcp/docs"
cp "$MCP_ROOT/docs/"*.md "$STAGE_DIR/krusch-context-mcp/docs/" 2>/dev/null || true
if [ -d "$MCP_ROOT/evals" ]; then
  cp -r "$MCP_ROOT/evals" "$STAGE_DIR/krusch-context-mcp/"
fi

if [ -f "$LORA_ADAPTER_GGUF" ] && [ -f "$FUSE_SCRIPT" ]; then
  cp "$LORA_ADAPTER_GGUF" "$STAGE_DIR/lora/adapter.gguf"
  cp "$FUSE_SCRIPT" "$STAGE_DIR/lora/fuse_lora_into_gguf.py"
fi

tar -czf /tmp/beam-closed-bundle.tar.gz -C "$STAGE_DIR" .
rm -rf "$STAGE_DIR"
ls -lh /tmp/beam-closed-bundle.tar.gz

STATUS_OUT=$("$COLAB_BIN" status -s "$SESSION" 2>&1 || true)
if echo "$STATUS_OUT" | grep -qi "not found" || ! echo "$STATUS_OUT" | grep -qi "colab-g4"; then
  echo "[beam-g4] Allocating 96GB NVIDIA RTX PRO 6000 Blackwell (--gpu G4)..."
  "$COLAB_BIN" new -s "$SESSION" --gpu G4
  sleep 3
fi

echo "[beam-g4] Uploading clean-room bundle to /content/beam-closed-bundle.tar.gz..."
UPLOAD_OK=0
for attempt in 1 2 3 4 5; do
  if "$COLAB_BIN" upload -s "$SESSION" /tmp/beam-closed-bundle.tar.gz /content/beam-closed-bundle.tar.gz; then
    UPLOAD_OK=1
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "[beam-g4] Colab proxy TLS endpoint unhealthy; recycling G4 session..."
    "$COLAB_BIN" stop -s "$SESSION" >/dev/null 2>&1 || true
    sleep 2
    "$COLAB_BIN" new -s "$SESSION" --gpu G4
    sleep 5
  else
    echo "[beam-g4] Retrying upload (${attempt}/5)..."
    sleep 5
  fi
done
if [ "$UPLOAD_OK" -ne 1 ]; then
  echo "[beam-g4] ERROR: Failed to upload bundle to Colab G4."
  exit 1
fi

echo "[beam-g4] Executing closed-system full 400/400 BEAM benchmark + QLoRA A/B inside G4..."
"$COLAB_BIN" exec -s "$SESSION" --timeout 7200 << 'PYEOF'
import json, os, select, shutil, subprocess, sys, time, urllib.request

def run_stream(cmd_args, cwd=None, env=None, shell=False):
    proc = subprocess.Popen(
        cmd_args,
        cwd=cwd,
        env=env,
        shell=shell,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    fd = proc.stdout.fileno()
    t0 = time.monotonic()
    while True:
        rlist, _, _ = select.select([fd], [], [], 20.0)
        if rlist:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace").replace("\r", "\n")
            sys.stdout.write(text)
            sys.stdout.flush()
        else:
            if proc.poll() is not None:
                break
            elapsed = int(time.monotonic() - t0)
            sys.stdout.write(f"[beam-g4] heartbeat ({elapsed}s elapsed)...\n")
            sys.stdout.flush()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"Command {cmd_args} exited with code {rc}")

print("=== [Stage 1/4] Provisioning Clean-Room Environment (Node 22 + Ollama Loopback) ===", flush=True)
run_stream("rm -rf /root/beam-cleanroom /tmp/beam_100k_official.json /tmp/beam_100k_clean_embeddings.json && mkdir -p /root/beam-cleanroom && tar -xzf /content/beam-closed-bundle.tar.gz -C /root/beam-cleanroom", shell=True)

# Ensure Node.js >= 22 is installed
need_node22 = True
if shutil.which("node"):
    ver_out = subprocess.check_output(["node", "-v"], text=True).strip()
    major = int(ver_out.lstrip("v").split(".")[0])
    if major >= 22:
        need_node22 = False
        print(f"[beam-g4] Existing Node.js {ver_out} satisfies >=22.", flush=True)

if need_node22:
    print("[beam-g4] Installing official Node.js v22 LTS binary...", flush=True)
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
run_stream("node -v && npm -v", shell=True)
run_stream("npm ci --no-audit --no-fund", cwd="/root/beam-cleanroom/krusch-context-mcp", shell=True)
run_stream("CI=true node --test --test-concurrency=1 tests/*.test.js", cwd="/root/beam-cleanroom/krusch-context-mcp", shell=True)

# Install & start Ollama bound strictly to 127.0.0.1:11434
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
log_fh = open("/tmp/ollama_beam.log", "w")
subprocess.Popen(["ollama", "serve"], env=ollama_env, stdin=subprocess.DEVNULL, stdout=log_fh, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
for _ in range(30):
    try:
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2)
        break
    except Exception:
        time.sleep(1)

print("=== [Stage 2/4] Pulling Open-Weights Models onto Isolated G4 Loopback ===", flush=True)
for mdl in ["bge-large:latest", "gpt-oss:120b", "qwen2.5:32b", "hermes3:latest"]:
    print(f"[beam-g4] Pulling {mdl}...", flush=True)
    run_stream(["ollama", "pull", mdl])

gpu_info = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], text=True).strip()
ollama_tags = json.loads(urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=10).read().decode("utf-8"))
model_digests = {m["name"]: m.get("digest", "") for m in ollama_tags.get("models", [])}
print(f"[beam-g4] Hardware: {gpu_info}", flush=True)
print(f"[beam-g4] Model Digests: {json.dumps(model_digests, indent=2)}", flush=True)

# Warm all 3 generation models into 97.9 GB VRAM simultaneously and verify 100% GPU residency
for mdl, ctx in [("gpt-oss:120b", 16384), ("qwen2.5:32b", 4096), ("hermes3:latest", 4096)]:
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps({"model": mdl, "prompt": "ok", "stream": False, "keep_alive": -1, "options": {"num_ctx": ctx, "num_predict": 1}}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=180).read()

run_stream(["ollama", "ps"])

print("=== [Stage 3/4] Running Full 400/400 Official BEAM 100K (Unmodified Stock gpt-oss:120b + Dual Cross-Family Judges) ===", flush=True)
closed_meta = {
    "execution_mode": "Hermetic Single-Box Closed System (Zero External LLM APIs, Zero LAN, Fresh Embeddings)",
    "gpu_hardware": gpu_info,
    "ollama_bind_host": "127.0.0.1:11434",
    "gemini_api_key_present": False,
    "ollama_model_sha256_digests": model_digests,
}

bench_env = os.environ.copy()
bench_env.pop("GEMINI_API_KEY", None)
bench_env["GEMINI_API_KEY"] = ""
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
    ["node", "scripts/benchmark_official_beam.js", "--full-judge"],
    cwd="/root/beam-cleanroom/krusch-context-mcp",
    env=bench_env,
)
run_stream(
    ["node", "benchmarks/verify_zero_leakage.js"],
    cwd="/root/beam-cleanroom/krusch-context-mcp",
    env=bench_env,
)

shutil.copy2(
    "/root/beam-cleanroom/krusch-context-mcp/benchmarks/beam_100k_audit_log.json",
    "/content/beam_100k_audit_log.json",
)

with open("/content/beam_100k_audit_log.json", "r", encoding="utf-8") as fh:
    stock_report = json.load(fh)

# Compute exact n=20 stratified slice (conv <= 2 && question_index == 0) from stock 400/400 run for A/B gate
stock_n20_entries = [
    e for e in stock_report["audit_log"]
    if e["conversation_id"] <= 2 and e["question_index"] == 0 and e.get("llm_judge_score") is not None
]
stock_n20_primary = round(sum(e["llm_judge_score"] for e in stock_n20_entries) / len(stock_n20_entries) * 100, 2)
stock_n20_sec = round(sum(e.get("secondary_judge_score", 0.0) for e in stock_n20_entries) / len(stock_n20_entries) * 100, 2)
print(
    f"\n[beam-g4] Stock gpt-oss:120b Full 400/400 E2E: qwen2.5:32b={stock_report['overall']['llm_judge_10cat_pct']}% | "
    f"hermes3:latest={stock_report['overall'].get('secondary_llm_judge_10cat_pct')}%\n"
    f"[beam-g4] Stock gpt-oss:120b n=20 Gate Slice : qwen2.5:32b={stock_n20_primary}% | hermes3:latest={stock_n20_sec}%\n",
    flush=True,
)

if os.path.exists("/root/beam-cleanroom/lora/adapter.gguf"):
    print("=== [Stage 4/4] Fusing krush420/gpt-oss-120b-sre-lora In-Place for Controlled A/B Ablation ===", flush=True)
    try:
        # Evict stock gpt-oss:120b from VRAM so GGUF file can be modified cleanly in-place
        evict_req = urllib.request.Request(
            "http://127.0.0.1:11434/api/generate",
            data=json.dumps({"model": "gpt-oss:120b", "keep_alive": 0}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(evict_req, timeout=30).read()
        time.sleep(2)

        mf_out = subprocess.check_output(["ollama", "show", "--modelfile", "gpt-oss:120b"], text=True)
        base_blob = None
        for line in mf_out.splitlines():
            if line.startswith("FROM /"):
                base_blob = line.split("FROM ", 1)[1].strip()
                break
        if not base_blob or not os.path.exists(base_blob):
            raise RuntimeError(f"Could not locate base GGUF blob in Modelfile: {mf_out[:200]}")

        run_stream([
            "python3",
            "/root/beam-cleanroom/lora/fuse_lora_into_gguf.py",
            "--base-gguf", base_blob,
            "--adapter-gguf", "/root/beam-cleanroom/lora/adapter.gguf",
            "--output-gguf", base_blob,
        ])
        run_stream(["ollama", "cp", "gpt-oss:120b", "gpt-oss-120b-sre-qlora:latest"])

        # Warm fused model into VRAM
        warm_req = urllib.request.Request(
            "http://127.0.0.1:11434/api/generate",
            data=json.dumps({"model": "gpt-oss-120b-sre-qlora:latest", "prompt": "ok", "stream": False, "keep_alive": -1, "options": {"num_ctx": 16384, "num_predict": 1}}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(warm_req, timeout=180).read()

        qlora_env = bench_env.copy()
        qlora_env["READER_MODEL"] = "gpt-oss-120b-sre-qlora:latest"
        qlora_meta = dict(closed_meta)
        qlora_meta["qlora_adapter"] = "krush420/gpt-oss-120b-sre-lora (r=16, alpha=32, 288 q/k/v/o attention matrices fused in-place)"
        qlora_env["BEAM_CLOSED_SYSTEM_META"] = json.dumps(qlora_meta)

        run_stream(
            [
                "node", "scripts/benchmark_official_beam.js",
                "--judge-convs=2",
                "--results-out=/tmp/beam_qlora_n20_results.json",
                "--audit-log-out=/content/beam_100k_qlora_n20_audit_log.json",
            ],
            cwd="/root/beam-cleanroom/krusch-context-mcp",
            env=qlora_env,
        )
        run_stream(
            ["node", "benchmarks/verify_zero_leakage.js", "--audit-log=/content/beam_100k_qlora_n20_audit_log.json"],
            cwd="/root/beam-cleanroom/krusch-context-mcp",
            env=qlora_env,
        )

        with open("/content/beam_100k_qlora_n20_audit_log.json", "r", encoding="utf-8") as fh:
            qlora_n20_report = json.load(fh)
        qlora_n20_primary = qlora_n20_report["overall"]["llm_judge_10cat_pct"]
        qlora_n20_sec = qlora_n20_report["overall"].get("secondary_llm_judge_10cat_pct")
        print(
            f"\n[beam-g4] A/B Gate Comparison (n=20/400):\n"
            f"   • Stock gpt-oss:120b        : qwen2.5:32b={stock_n20_primary}% | hermes3:latest={stock_n20_sec}%\n"
            f"   • QLoRA gpt-oss-120b-sre    : qwen2.5:32b={qlora_n20_primary}% | hermes3:latest={qlora_n20_sec}%\n",
            flush=True,
        )

        if qlora_n20_primary is not None and qlora_n20_primary > stock_n20_primary:
            print("[beam-g4] 🚀 QLoRA BEAT stock on n=20 gate! Auto-promoting to Full 400/400 evaluation...", flush=True)
            run_stream(
                [
                    "node", "scripts/benchmark_official_beam.js",
                    "--full-judge",
                    "--results-out=/tmp/beam_qlora_full400_results.json",
                    "--audit-log-out=/content/beam_100k_qlora_full400_audit_log.json",
                ],
                cwd="/root/beam-cleanroom/krusch-context-mcp",
                env=qlora_env,
            )
            run_stream(
                ["node", "benchmarks/verify_zero_leakage.js", "--audit-log=/content/beam_100k_qlora_full400_audit_log.json"],
                cwd="/root/beam-cleanroom/krusch-context-mcp",
                env=qlora_env,
            )
        else:
            print("[beam-g4] Stock unmodified gpt-oss:120b matched or outperformed SRE QLoRA on conversational QA gate; conserving Compute Units.", flush=True)
    except Exception as ab_err:
        print(f"[beam-g4] WARNING: QLoRA A/B stage encountered non-fatal error (stock 400/400 audit log is safely preserved): {ab_err}", flush=True)

run_stream("tar -czf /content/beam_g4_results.tar.gz -C /content $(ls /content | grep '^beam_100k_.*\\.json$')", shell=True)
print("=== ALL G4 BENCHMARK STAGES COMPLETE! ARTIFACTS PACKAGED AT /content/beam_g4_results.tar.gz ===", flush=True)
PYEOF

echo "[beam-g4] Downloading verified results bundle from G4..."
mkdir -p "$MCP_ROOT/benchmarks/g4_closed_system"
for attempt in 1 2 3 4 5; do
  if "$COLAB_BIN" download -s "$SESSION" /content/beam_g4_results.tar.gz /tmp/beam_g4_results.tar.gz; then
    break
  fi
  sleep 4
done

if [ ! -f /tmp/beam_100k_official.json ]; then
  "$COLAB_BIN" download -s "$SESSION" /tmp/beam_100k_official.json /tmp/beam_100k_official.json || true
fi
tar -xzf /tmp/beam_g4_results.tar.gz -C "$MCP_ROOT/benchmarks/g4_closed_system/"
cp "$MCP_ROOT/benchmarks/g4_closed_system/beam_100k_audit_log.json" "$MCP_ROOT/benchmarks/beam_100k_audit_log.json"

echo "[beam-g4] Running local cryptographic & mathematical verification (npm run bench:beam:verify)..."
(cd "$MCP_ROOT" && npm run bench:beam:verify)

echo "[beam-g4] Closed-system G4 benchmark completed and verified! Teardown will now run via EXIT trap."
