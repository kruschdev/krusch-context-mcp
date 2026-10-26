#!/usr/bin/env python3
"""
Zero-Leakage Official Hugging Face Parquet -> Streaming NDJSON Preparer for Mohammadta/BEAM
Supports Official Splits: 500K, 1M (Mohammadta/BEAM) and 10M (Mohammadta/BEAM-10M).

Guarantees:
  1. Verifies exact Hugging Face Git-LFS SHA-256 digests of raw upstream Parquet shards.
  2. Normalizes 10M multi-plan `chat` (`plan-1`..`plan-10`) into the canonical `Array<Array<Message>>`
     session-batch structure while preserving 100% of raw message `id`, `role`, `content`, and `time_anchor`
     fields in exact chronological order (zero filtering, zero summarization, zero oracle inspection).
  3. Emits streaming NDJSON (1 conversation JSON object per line) + SHA-256 provenance manifest so
     Node.js can stream 10M (~463M chars) without hitting V8's 512 MB single-string limit.
"""

import argparse
import ast
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

# Re-exec into a local virtualenv with pyarrow if system python3 lacks pyarrow
try:
    import pyarrow.parquet as pq
except ImportError:
    _repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    _workspace_root = os.path.abspath(os.path.join(_repo_root, "..", ".."))
    FALLBACK_PYTHONS = [
        os.path.join(_repo_root, ".venv", "bin", "python"),
        os.path.join(_workspace_root, ".venv", "bin", "python"),
        os.path.join(_workspace_root, "projects", "krusch-law", ".venv", "bin", "python"),
        os.path.join(_workspace_root, "projects", "krusch-biz", ".venv", "bin", "python"),
    ]
    for candidate in FALLBACK_PYTHONS:
        if os.path.exists(candidate) and os.path.abspath(candidate) != os.path.abspath(sys.executable):
            os.execv(candidate, [candidate, *sys.argv])
    raise RuntimeError("pyarrow is required to read official BEAM Parquet shards.")

OFFICIAL_SPLITS = {
    "500K": {
        "dataset": "Mohammadta/BEAM",
        "expected_conversations": 35,
        "shards": [
            {
                "filename": "500K-00000-of-00001.parquet",
                "url": "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/500K-00000-of-00001.parquet",
                "sha256": "af05921c979355038e1761b7cde3d2dd713200dd3071b278de0200f6c7f30122",
            }
        ],
    },
    "1M": {
        "dataset": "Mohammadta/BEAM",
        "expected_conversations": 35,
        "shards": [
            {
                "filename": "1M-00000-of-00001.parquet",
                "url": "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/1M-00000-of-00001.parquet",
                "sha256": "41b5acbbb55a586b1305514ef9d9fb03365d9b3331b598a1c2dd7603d93ef533",
            }
        ],
    },
    "10M": {
        "dataset": "Mohammadta/BEAM-10M",
        "expected_conversations": 10,
        "shards": [
            {
                "filename": "10M-00000-of-00002.parquet",
                "url": "https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/main/data/10M-00000-of-00002.parquet",
                "sha256": "31d96fd47ec56221d202e68792f26c00e49467dd4b36ee105c36ebd19ef78ad5",
            },
            {
                "filename": "10M-00001-of-00002.parquet",
                "url": "https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/main/data/10M-00001-of-00002.parquet",
                "sha256": "a4f13fe25af51d57405ae41008689c31d1421377f3efde56a024b441deb2ee65",
            },
        ],
    },
}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(4 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def parse_json_or_literal(raw):
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return ast.literal_eval(raw)


def download_if_needed(url: str, dest: str, expected_sha256: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        actual = sha256_file(dest)
        if actual == expected_sha256:
            return actual
        os.remove(dest)

    print(f"[prepare_beam_split] Downloading {url} -> {dest}...", flush=True)
    tmp_dest = dest + ".part"
    if os.path.exists(tmp_dest):
        os.remove(tmp_dest)

    req = urllib.request.Request(url, headers={"User-Agent": "krusch-context-mcp-beam-bench/1.9.0"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(tmp_dest, "wb") as out_fh:
        while True:
            buf = resp.read(4 * 1024 * 1024)
            if not buf:
                break
            out_fh.write(buf)

    actual = sha256_file(tmp_dest)
    if actual != expected_sha256:
        os.remove(tmp_dest)
        raise RuntimeError(
            f"SHA-256 mismatch for {url}: expected {expected_sha256}, got {actual}"
        )
    os.replace(tmp_dest, dest)
    return actual


def normalize_10m_chat(raw_chat) -> list:
    """
    Flattens BEAM-10M's `chat` list of `plan-1`..`plan-10` batch structs into
    canonical `Array<Array<{id, role, content, time_anchor}>>` session batches.
    Preserves exact plan order (`elem` order in `raw_chat`) and batch order.
    """
    batches = []
    for elem in raw_chat or []:
        if not isinstance(elem, dict):
            continue
        # Each list element has a single non-null key ('plan-1', 'plan-2', ..., 'plan-10')
        for k in sorted(elem.keys(), key=lambda x: int(x.split("-")[1]) if "-" in x and x.split("-")[1].isdigit() else 999):
            plan_batches = elem[k]
            if not plan_batches:
                continue
            for b_obj in plan_batches:
                batch_anchor = b_obj.get("time_anchor")
                flat_msgs = []
                for turn_group in b_obj.get("turns", []):
                    for m in turn_group:
                        flat_msgs.append(
                            {
                                "id": int(m["id"]),
                                "role": m.get("role") or "",
                                "content": m.get("content") or "",
                                "time_anchor": m.get("time_anchor") or batch_anchor or "",
                            }
                        )
                if flat_msgs:
                    batches.append(flat_msgs)
    return batches


def normalize_standard_chat(raw_chat) -> list:
    batches = []
    for batch in raw_chat or []:
        flat_msgs = []
        for m in batch or []:
            flat_msgs.append(
                {
                    "id": int(m["id"]),
                    "role": m.get("role") or "",
                    "content": m.get("content") or "",
                    "time_anchor": m.get("time_anchor") or "",
                }
            )
        if flat_msgs:
            batches.append(flat_msgs)
    return batches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", required=True, choices=["500K", "1M", "10M"])
    parser.add_argument("--parquet-dir", default="/tmp/beam_parquet")
    parser.add_argument("--out-jsonl", default="")
    args = parser.parse_args()

    split = args.split
    spec = OFFICIAL_SPLITS[split]
    out_jsonl = args.out_jsonl or f"/tmp/beam_{split.lower()}_official.jsonl"
    meta_path = out_jsonl + ".meta.json"

    # Fast reuse if JSONL and meta already exist and match SHA-256
    if os.path.exists(out_jsonl) and os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as mfh:
                meta = json.load(mfh)
            if (
                meta.get("split") == split
                and meta.get("conversations") == spec["expected_conversations"]
                and meta.get("jsonl_sha256") == sha256_file(out_jsonl)
            ):
                print(
                    f"[prepare_beam_split] Verified cached {split} NDJSON ({meta['conversations']} convs, sha256={meta['jsonl_sha256'][:16]}...)",
                    flush=True,
                )
                return
        except Exception:
            pass

    shard_digests = {}
    for shard in spec["shards"]:
        dest = os.path.join(args.parquet_dir, shard["filename"])
        digest = download_if_needed(shard["url"], dest, shard["sha256"])
        shard_digests[shard["filename"]] = digest

    print(f"[prepare_beam_split] Converting verified {split} Parquet shard(s) -> {out_jsonl}...", flush=True)
    tmp_jsonl = out_jsonl + ".part"
    conv_count = 0
    total_msgs = 0
    total_chars = 0
    total_questions = 0

    with open(tmp_jsonl, "w", encoding="utf-8") as out_fh:
        for shard in spec["shards"]:
            p_path = os.path.join(args.parquet_dir, shard["filename"])
            pf = pq.ParquetFile(p_path)
            for rg_idx in range(pf.num_row_groups):
                table = pf.read_row_group(rg_idx)
                for row in table.to_pylist():
                    conv_id = str(row["conversation_id"])
                    seed = parse_json_or_literal(row.get("conversation_seed")) or {}
                    pqs = parse_json_or_literal(row.get("probing_questions")) or {}
                    chat_batches = (
                        normalize_10m_chat(row.get("chat"))
                        if split == "10M"
                        else normalize_standard_chat(row.get("chat"))
                    )
                    for b in chat_batches:
                        total_msgs += len(b)
                        for m in b:
                            total_chars += len(m.get("content") or "")
                    for q_list in pqs.values():
                        total_questions += len(q_list or [])

                    record = {
                        "conversation_id": conv_id,
                        "conversation_seed": {
                            "title": seed.get("title") or f"Conversation {conv_id}",
                            "category": seed.get("category") or "",
                            "theme": seed.get("theme") or "",
                        },
                        "chat": chat_batches,
                        "probing_questions_parsed": pqs,
                    }
                    out_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                    conv_count += 1

    if conv_count != spec["expected_conversations"]:
        os.remove(tmp_jsonl)
        raise RuntimeError(
            f"Expected {spec['expected_conversations']} conversations for {split}, got {conv_count}"
        )

    os.replace(tmp_jsonl, out_jsonl)
    jsonl_sha = sha256_file(out_jsonl)
    meta = {
        "dataset": spec["dataset"],
        "split": split,
        "conversations": conv_count,
        "messages": total_msgs,
        "chars": total_chars,
        "probing_questions": total_questions,
        "parquet_lfs_sha256": shard_digests,
        "jsonl_sha256": jsonl_sha,
    }
    with open(meta_path, "w", encoding="utf-8") as mfh:
        json.dump(meta, mfh, indent=2)

    print(
        f"[prepare_beam_split] Ready: {split} | convs={conv_count} | msgs={total_msgs:,} | chars={total_chars:,} | qs={total_questions} | jsonl_sha256={jsonl_sha}",
        flush=True,
    )


if __name__ == "__main__":
    main()
