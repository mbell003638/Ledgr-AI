"""
Needle LoRA train with periodic checkpoints so a crash can resume.

Stock `needle finetune` only writes the adapter after the last step.
This loop is the same train math, plus a pickle of LoRA + optimizer
state every N steps. Internet is not used.

Resume: run the same command. Delete the .ckpt file (or set
NEEDLE_RESET_CKPT=1) to start over.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import signal
import sys
import time

import numpy as np

from needle.model.architecture import SimpleAttentionNetwork
from needle.model.finetune import (
    DEFAULT_BASE,
    fit_max_len,
    init_lora,
    load_jsonl,
    lora_target_paths,
    merge_lora,
)
from needle.model.quantize import (
    configure_deploy,
    cq_ste_mixed_params,
    cq_ste_params,
    parse_bits_map,
)
from needle.model.run import load_checkpoint
from needle.model.tokenizer import get_tokenizer

_stop = False
_ckpt_ready = False
_latest = {}


def emit(msg):
    print(msg, flush=True)


def _handle_signal(signum, _frame):
    global _stop
    _stop = True
    emit(f"  {'signal':<9} {signum} — will save checkpoint after this step")


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint(args, jsonl_path):
    return {
        "jsonl": os.path.abspath(jsonl_path),
        "jsonl_size": os.path.getsize(jsonl_path),
        "jsonl_sha256": _sha256_file(jsonl_path),
        "epochs": int(args.epochs),
        "batch_size": int(args.batch_size),
        "max_len": int(args.max_len) if args.max_len else None,
        "val_split": float(args.val_split),
        "lora_rank": int(args.lora_rank),
        "lora_alpha": float(args.lora_alpha),
        "base": os.path.abspath(args.checkpoint or DEFAULT_BASE),
        "qat_bits": args.qat_bits,
        "lr": float(args.lr),
    }


def _to_numpy(tree):
    import jax
    return jax.tree.map(lambda x: np.asarray(x) if hasattr(x, "ndim") else x, tree)


def _to_jax(tree):
    # `import jax.numpy as jnp` binds only `jnp`, not `jax`, so jax.tree.map
    # below raised NameError. _to_numpy (the save path) imports jax and worked,
    # which is why checkpoints were written happily and could never be restored:
    # every resume died here before the first step.
    import jax
    import jax.numpy as jnp
    return jax.tree.map(lambda x: jnp.asarray(x) if isinstance(x, np.ndarray) else x, tree)


def _lora_to_store(lora):
    return {
        "/".join(path): {"A": np.asarray(val["A"]), "B": np.asarray(val["B"])}
        for path, val in lora.items()
    }


def _lora_from_store(stored):
    import jax.numpy as jnp
    out = {}
    for key, val in stored.items():
        path = tuple(key.split("/"))
        out[path] = {"A": jnp.asarray(val["A"]), "B": jnp.asarray(val["B"])}
    return out


def _write_json(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    os.replace(tmp, path)


def save_checkpoint(path, *, fingerprint, lora, opt_state, step_i, epoch, order,
                    next_start, last_loss, total_steps, done, extra):
    payload = {
        "version": 1,
        "fingerprint": fingerprint,
        "lora": _lora_to_store(lora),
        "opt_state": _to_numpy(opt_state),
        "step_i": int(step_i),
        "epoch": int(epoch),
        "order": np.asarray(order) if order is not None else None,
        "next_start": int(next_start),
        "last_loss": None if last_loss is None else float(last_loss),
        "total_steps": int(total_steps),
        "done": bool(done),
        **extra,
    }
    tmp = path + ".tmp"
    with open(tmp, "wb") as handle:
        pickle.dump(payload, handle, protocol=4)
    os.replace(tmp, path)
    _write_json(path + ".json", {
        "step": payload["step_i"],
        "total": payload["total_steps"],
        "epoch": payload["epoch"],
        "next_start": payload["next_start"],
        "loss": payload["last_loss"],
        "done": payload["done"],
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })
    emit(f"  {'ckpt':<9} step {step_i}/{total_steps}  {path}")


def dump_adapter(out, lora, scale, base_path, rank, qat_bits, qat_bits_map):
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "wb") as handle:
        pickle.dump({
            "lora": _lora_to_store(lora),
            "scale": float(scale),
            "base": base_path,
            "rank": rank,
            "qat_bits": qat_bits,
            "qat_bits_map": qat_bits_map,
        }, handle)
    os.replace(tmp, out)
    emit(f"  {'adapter':<9} {out}")


def main():
    global _ckpt_ready, _latest
    parser = argparse.ArgumentParser(description="Needle LoRA fine-tune with resume checkpoints")
    parser.add_argument("jsonl_path")
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=float, default=32)
    parser.add_argument("--max-len", type=int, default=256)
    parser.add_argument("--val-split", type=float, default=0.1)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ckpt", default=None, help="Resume pickle (default: <out>.ckpt)")
    parser.add_argument("--ckpt-every", type=int, default=int(os.environ.get("NEEDLE_CKPT_EVERY", "25")))
    parser.add_argument("--qat-bits", default="auto")
    parser.add_argument("--reset-ckpt", action="store_true")
    args = parser.parse_args()

    jsonl_path = os.path.abspath(args.jsonl_path)
    ckpt_path = os.path.abspath(args.ckpt or (args.out + ".ckpt"))
    if args.reset_ckpt or os.environ.get("NEEDLE_RESET_CKPT") == "1":
        for extra in (ckpt_path, ckpt_path + ".json", ckpt_path + ".tmp"):
            if os.path.exists(extra):
                os.remove(extra)
                emit(f"  {'reset':<9} removed {extra}")

    for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None), getattr(signal, "SIGBREAK", None)):
        if sig is not None:
            try:
                signal.signal(sig, _handle_signal)
            except (OSError, ValueError):
                pass

    import jax
    import jax.numpy as jnp
    import optax

    base_path = os.path.abspath(args.checkpoint or DEFAULT_BASE)
    args.checkpoint = base_path
    fingerprint = _fingerprint(args, jsonl_path)

    params, config = load_checkpoint(base_path)
    config.dtype = "float32"
    params = jax.tree.map(lambda a: np.asarray(a).astype(np.float32), params)
    backend = jax.default_backend().lower()
    if backend == "metal":
        config.flash = False
        config.remat = False
        config.scan_unroll = config.num_layers
    params = jax.device_put(params)
    emit(f"  {'backend':<9} {backend}  float32")
    tokenizer = get_tokenizer(config.vocab_size)
    max_len = fit_max_len(jsonl_path, tokenizer, args.max_len)
    seqs, masks = load_jsonl(jsonl_path, tokenizer, max_len)
    if len(seqs) == 0:
        raise SystemExit("no usable examples in " + jsonl_path)
    emit(f"  {'data':<9} {len(seqs)} examples  seq_len {max_len}  cap {args.max_len}")

    model = SimpleAttentionNetwork(config)
    qat_mode = str(args.qat_bits or "auto").lower()
    qat_bits = None
    qat_bits_map = None
    parsed_bits_map = None
    if qat_mode == "auto":
        qat_bits_map = getattr(config, "weight_bits", "") or None
        if qat_bits_map:
            parsed_bits_map = parse_bits_map(qat_bits_map)
        else:
            qat_bits = 4
    elif qat_mode in ("2", "4"):
        qat_bits = int(qat_mode)
    elif qat_mode != "none":
        raise ValueError("--qat-bits must be auto, none, 2, or 4")
    qat_enabled = qat_bits is not None or qat_bits_map is not None
    if qat_enabled:
        configure_deploy(act_bits=getattr(config, "act_bits", 8),
                         kv_bits=getattr(config, "kv_bits", 8))
        scheme = f"mixed[{qat_bits_map}]" if qat_bits_map else f"W{qat_bits}"
        emit(f"  {'numerics':<9} CQ {scheme} STE + A8 (matches export)")
    else:
        emit(f"  {'numerics':<9} full precision")

    paths = lora_target_paths(params)
    scale = args.lora_alpha / args.lora_rank
    lora = init_lora(params, paths, args.lora_rank, jax.random.PRNGKey(0))
    emit(f"  {'lora':<9} rank {args.lora_rank}  alpha {args.lora_alpha:g}  {len(paths)} weight groups")

    n_val = min(int(len(seqs) * args.val_split), len(seqs) - 1)
    if n_val > 0:
        order_val = np.random.default_rng(0).permutation(len(seqs))
        seqs, masks = seqs[order_val], masks[order_val]
        val_seqs, val_masks = seqs[:n_val], masks[:n_val]
        seqs, masks = seqs[n_val:], masks[n_val:]
        emit(f"  {'holdout':<9} {n_val} examples for validation")
    else:
        val_seqs = val_masks = None

    batch, count = args.batch_size, len(seqs)
    steps_per_epoch = -(-count // batch)
    total_steps = args.epochs * steps_per_epoch
    warmup = min(max(1, total_steps // 20), total_steps - 1)
    schedule = optax.warmup_cosine_decay_schedule(
        init_value=0.0, peak_value=args.lr,
        warmup_steps=warmup, decay_steps=total_steps)
    optimizer = optax.chain(optax.clip_by_global_norm(1.0), optax.adamw(schedule))
    opt_state = optimizer.init(lora)
    emit(f"  {'schedule':<9} {total_steps} steps  warmup {warmup}  cosine decay  clip 1.0  ckpt every {args.ckpt_every}")

    def loss_fn(lora, ids, mask):
        merged = merge_lora(params, lora, scale)
        if qat_bits_map is not None:
            bits_map, default_bits = parsed_bits_map
            merged = cq_ste_mixed_params(merged, bits_map, default_bits)
        elif qat_bits is not None:
            merged = cq_ste_params(merged, qat_bits)
        logits = model.apply({"params": merged}, ids, quant=qat_enabled)
        logits, targets, mask = logits[:, :-1], ids[:, 1:], mask[:, 1:]
        ce = optax.softmax_cross_entropy_with_integer_labels(logits, targets)
        return (ce * mask).sum() / jnp.maximum(mask.sum(), 1.0)

    @jax.jit
    def train_step(lora, opt_state, ids, mask):
        loss, grads = jax.value_and_grad(loss_fn)(lora, ids, mask)
        updates, opt_state = optimizer.update(grads, opt_state, lora)
        return optax.apply_updates(lora, updates), opt_state, loss

    eval_step = jax.jit(loss_fn)

    step_i = 0
    start_epoch = 0
    resume_order = None
    resume_start = 0
    last = 0.0
    extra = {"scale": float(scale), "fitted_max_len": int(max_len), "n_val": int(n_val), "count": int(count)}

    if os.path.exists(ckpt_path):
        with open(ckpt_path, "rb") as handle:
            saved = pickle.load(handle)
        if saved.get("fingerprint") != fingerprint:
            emit(f"  {'resume':<9} checkpoint fingerprint mismatch — starting from step 0")
        else:
            lora = _lora_from_store(saved["lora"])
            opt_state = _to_jax(saved["opt_state"])
            step_i = int(saved["step_i"])
            start_epoch = int(saved["epoch"])
            resume_order = None if saved.get("order") is None else np.asarray(saved["order"])
            resume_start = int(saved.get("next_start") or 0)
            last = float(saved["last_loss"] or 0.0)
            emit(f"  {'resume':<9} step {step_i}/{total_steps}  epoch {start_epoch}  next_start {resume_start}")
            if saved.get("done") or step_i >= total_steps:
                dump_adapter(args.out, lora, scale, base_path, args.lora_rank, qat_bits, qat_bits_map)
                emit(f"  {'next':<9} needle build {base_path} --lora {args.out}")
                return

    _ckpt_ready = True

    def persist(epoch, order, next_start, done=False):
        save_checkpoint(
            ckpt_path,
            fingerprint=fingerprint,
            lora=lora,
            opt_state=opt_state,
            step_i=step_i,
            epoch=epoch,
            order=order,
            next_start=next_start,
            last_loss=last,
            total_steps=total_steps,
            done=done,
            extra=extra,
        )

    emit("  compiling  first train step (XLA)...")
    every = max(1, total_steps // 50)
    ckpt_every = max(1, args.ckpt_every)

    for epoch in range(start_epoch, args.epochs):
        if resume_order is not None:
            order = resume_order
            batch_start = resume_start
            resume_order = None
            resume_start = 0
        else:
            order = np.random.permutation(count)
            batch_start = 0
        for start in range(batch_start, count, batch):
            idx = order[start:start + batch]
            lora, opt_state, loss = train_step(
                lora, opt_state, jnp.asarray(seqs[idx]), jnp.asarray(masks[idx]))
            last = float(loss)
            step_i += 1
            _latest = {"epoch": epoch, "order": order, "next_start": start + batch}
            if step_i % every == 0:
                emit(f"  {'step':<9} {step_i}/{total_steps}  loss {last:.4f}")
            if step_i % ckpt_every == 0:
                persist(epoch, order, start + batch)
            if _stop:
                persist(epoch, order, start + batch)
                emit(f"  {'stopped':<9} resume later from step {step_i}/{total_steps}")
                sys.exit(2)
        if n_val > 0:
            val = np.mean([
                float(eval_step(lora, jnp.asarray(val_seqs[i:i + batch]),
                                jnp.asarray(val_masks[i:i + batch])))
                for i in range(0, n_val, batch)
            ])
            emit(f"  {'epoch':<9} {epoch + 1}/{args.epochs}  loss {last:.4f}  val {val:.4f}")
        else:
            emit(f"  {'epoch':<9} {epoch + 1}/{args.epochs}  loss {last:.4f}")
        persist(epoch + 1, None, 0)

    persist(args.epochs, None, 0, done=True)
    dump_adapter(args.out, lora, scale, base_path, args.lora_rank, qat_bits, qat_bits_map)
    emit(f"  {'next':<9} needle build {base_path} --lora {args.out}")
    emit(f"  {'note':<9} confidence reports None with tuned weights; the head is not tuned")


if __name__ == "__main__":
    main()
