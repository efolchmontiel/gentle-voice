#!/usr/bin/env python3
"""
Persistent VibeVoice lab worker — JSONL FSM + instrumented cold start.

States emitted via {"op":"state","state":"..."}:
  STOPPED | STARTING | LOADING | WARMING | READY | SYNTHESIZING | ERROR | STOPPING

READY requires model+voice loaded and a tiny warm synth (handshake).
Cancel of a synth is client-side: worker finishes generate but client may discard.
Do NOT SIGKILL on Esc — that forces another cold start.

Protocol:
  → ping | synth | shutdown | status
  ← state | hello | pong | result | error | timeline
"""
from __future__ import annotations

import base64
import copy
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

_EMIT_LOCK = threading.Lock()

_home = os.environ.get("GENTLE_VOICE_VIBEVOICE_HOME", "").strip()
if not _home:
	print(json.dumps({"op": "error", "error": "GENTLE_VOICE_VIBEVOICE_HOME is required"}), flush=True)
	raise SystemExit(2)
ROOT = Path(_home)
DEFAULT_MODEL = ROOT / "models" / "VibeVoice-Realtime-0.5B"
DEFAULT_VOICE = ROOT / "code" / "demo" / "voices" / "streaming_model" / "sp-Spk0_woman.pt"
if not DEFAULT_VOICE.is_file():
	DEFAULT_VOICE = ROOT / "voices" / "sp-Spk0_woman.pt"

MODEL_PATH = Path(os.environ.get("GENTLE_VOICE_VIBEVOICE_MODEL", str(DEFAULT_MODEL)))
# from_pretrained wants the model directory. The adapter used to pass the weights file.
if MODEL_PATH.is_file():
	MODEL_PATH = MODEL_PATH.parent
VOICE_PT = Path(os.environ.get("GENTLE_VOICE_VIBEVOICE_VOICE_PT", str(DEFAULT_VOICE)))
DTYPE_NAME = os.environ.get("GENTLE_VOICE_VIBEVOICE_DTYPE", "auto")
CFG_SCALE = float(os.environ.get("GENTLE_VOICE_VIBEVOICE_CFG", "1.5"))
DDPM_STEPS = int(os.environ.get("GENTLE_VOICE_VIBEVOICE_DDPM_STEPS", "5"))
WARMUP_TEXT = os.environ.get("GENTLE_VOICE_VIBEVOICE_WARMUP_TEXT", ".").strip() or "."


def _emit(obj: dict) -> None:
	line = json.dumps(obj, ensure_ascii=False) + "\n"
	with _EMIT_LOCK:
		sys.stdout.write(line)
		sys.stdout.flush()


def _state(name: str, **extra) -> None:
	_emit({"op": "state", "state": name, **extra})


def _resolve_dtype(torch, device: str, requested: str):
	if requested == "auto":
		if device != "cuda":
			return torch.float32, "float32"
		# The checkpoint and the voice cache are bfloat16. float16 on Turing
		# leaves query in Half and key/value in float, and SDPA rejects the call.
		name = "bfloat16"
	else:
		name = requested
	if name not in ("float32", "float16", "bfloat16"):
		raise ValueError(f"unsupported_dtype:{name}")
	return getattr(torch, name), name


def _assert_model_files() -> None:
	"""Fail before torch. A wrong directory used to import CUDA and then miss the weights."""
	weights = MODEL_PATH / "model.safetensors"
	config = MODEL_PATH / "config.json"
	if weights.is_file() and config.is_file():
		return
	raise FileNotFoundError(f"model_files_missing:{MODEL_PATH}")


def _load():
	timeline: dict = {"t0_sec": 0.0}
	wall0 = time.perf_counter()
	_assert_model_files()

	_state("STARTING")
	t_import0 = time.perf_counter()
	import torch
	from transformers.cache_utils import DynamicCache
	from transformers.modeling_outputs import BaseModelOutputWithPast
	from vibevoice.modular.modeling_vibevoice_streaming_inference import (
		VibeVoiceStreamingForConditionalGenerationInference,
	)
	from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor

	timeline["import_sec"] = round(time.perf_counter() - t_import0, 3)
	_emit({"op": "timeline", "phase": "imports_done", **timeline})

	device = "cuda" if torch.cuda.is_available() else "cpu"
	dtype, dtype_name = _resolve_dtype(torch, device, DTYPE_NAME)
	timeline["device"] = device
	timeline["dtype"] = dtype_name

	if device == "cuda":
		t_cuda0 = time.perf_counter()
		torch.cuda.reset_peak_memory_stats()
		# Force context creation before weight load (isolates CUDA init cost).
		_ = torch.zeros(1, device="cuda")
		torch.cuda.synchronize()
		timeline["cuda_context_sec"] = round(time.perf_counter() - t_cuda0, 3)
		_emit({"op": "timeline", "phase": "cuda_context_ready", **timeline})

	_state("LOADING")
	t_proc0 = time.perf_counter()
	processor = VibeVoiceStreamingProcessor.from_pretrained(str(MODEL_PATH))
	timeline["processor_sec"] = round(time.perf_counter() - t_proc0, 3)
	_emit({"op": "timeline", "phase": "processor_loaded", **timeline})

	t_model0 = time.perf_counter()
	model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
		str(MODEL_PATH),
		torch_dtype=dtype,
		device_map="cuda" if device == "cuda" else "cpu",
		attn_implementation="sdpa",
	)
	model.eval()
	model.set_ddpm_inference_steps(num_steps=DDPM_STEPS)
	if device == "cuda":
		torch.cuda.synchronize()
	timeline["model_load_sec"] = round(time.perf_counter() - t_model0, 3)
	if device == "cuda":
		timeline["vram_after_model_mb"] = round(
			torch.cuda.max_memory_allocated() / (1024 * 1024), 1
		)
	_emit({"op": "timeline", "phase": "model_loaded", **timeline})

	t_voice0 = time.perf_counter()
	with torch.serialization.safe_globals([BaseModelOutputWithPast, DynamicCache]):
		cached = torch.load(str(VOICE_PT), map_location=device, weights_only=False)
	timeline["voice_load_sec"] = round(time.perf_counter() - t_voice0, 3)
	_emit({"op": "timeline", "phase": "voice_loaded", **timeline})

	ctx = {
		"device": device,
		"dtype": dtype_name,
		"processor": processor,
		"model": model,
		"cached": cached,
		"torch": torch,
		"safe_globals": [BaseModelOutputWithPast, DynamicCache],
	}

	_state("WARMING")
	t_warm0 = time.perf_counter()
	warm_metrics = _synth(ctx, WARMUP_TEXT, str(ROOT / "tmp" / "warmup-handshake.wav"), discard_audio=True)
	timeline["warmup_sec"] = round(time.perf_counter() - t_warm0, 3)
	timeline["warmup_ok"] = bool(warm_metrics.get("ok"))
	timeline["load_total_sec"] = round(time.perf_counter() - wall0, 3)
	if device == "cuda":
		timeline["vram_ready_mb"] = round(
			torch.cuda.max_memory_allocated() / (1024 * 1024), 1
		)
	_emit({"op": "timeline", "phase": "warmup_done", **timeline})

	if not warm_metrics.get("ok"):
		_state("ERROR", error=warm_metrics.get("error", "warmup_failed"))
		raise RuntimeError(f"warmup_failed:{warm_metrics.get('error')}")

	_state("READY", timeline=timeline)
	return ctx, timeline


def _voice_prompt(ctx: dict, voice_pt: str):
	"""Loads another voice preset once per worker; each synth deep-copies it."""
	extra = ctx.setdefault("extra_voices", {})
	if voice_pt not in extra:
		path = Path(voice_pt)
		if path.suffix != ".pt" or not path.is_file():
			raise FileNotFoundError(f"voice_missing:{path.name}")
		torch = ctx["torch"]
		with torch.serialization.safe_globals(ctx["safe_globals"]):
			extra[voice_pt] = torch.load(str(path), map_location=ctx["device"], weights_only=False)
	return extra[voice_pt]


def _synth(
	ctx: dict,
	text: str,
	out_wav: str,
	discard_audio: bool = False,
	stop_event: threading.Event | None = None,
	stream: bool = False,
	req_id: str | None = None,
	voice_pt: str = "",
) -> dict:
	torch = ctx["torch"]
	device = ctx["device"]
	processor = ctx["processor"]
	model = ctx["model"]
	cached = _voice_prompt(ctx, voice_pt) if voice_pt else ctx["cached"]
	metrics: dict = {
		"ok": False,
		"dtype": ctx["dtype"],
		"attn": "sdpa",
		"text_chars": len(text),
		"cfg_scale": CFG_SCALE,
		"ddpm_steps": DDPM_STEPS,
		"streaming_mode": "incremental_pcm" if stream else "batch_generate",
		"discard_audio": discard_audio,
	}
	collected: list = []
	seq = {"n": 0}
	clock = {"t0": 0.0, "first": None}
	streamer = None
	if stream:
		from vibevoice.modular.streamer import AudioStreamer

		closed = {"v": False}

		class _EmitPcm(AudioStreamer):
			def put(self, audio_chunks, sample_indices):
				# generate() also puts the rest of the speech window after EOS.
				# The approved WAV path drops those samples. Match it.
				if closed["v"]:
					return
				for i, _sample_idx in enumerate(sample_indices):
					chunk = audio_chunks[i].detach().float().cpu().reshape(-1).contiguous()
					collected.append(chunk)
					raw = chunk.numpy().tobytes()
					payload = {
						"op": "pcm",
						"req_id": req_id,
						"seq": seq["n"],
						"sample_rate": 24000,
						"channels": 1,
						"dtype": "float32",
						"samples": int(chunk.numel()),
						"pcm_b64": base64.b64encode(raw).decode("ascii"),
					}
					if seq["n"] == 0:
						clock["first"] = round(time.perf_counter() - clock["t0"], 3)
						payload["min"] = round(float(chunk.min()), 5)
						payload["max"] = round(float(chunk.max()), 5)
						payload["first_pcm_sec"] = clock["first"]
					seq["n"] += 1
					_emit(payload)

			def end(self, sample_indices=None):
				closed["v"] = True

		streamer = _EmitPcm(batch_size=1)
	_state("SYNTHESIZING", text_chars=len(text))
	if device == "cuda":
		torch.cuda.reset_peak_memory_stats()
		torch.cuda.synchronize()
	t_prep0 = time.perf_counter()
	inputs = processor.process_input_with_cached_prompt(
		text=text,
		cached_prompt=cached,
		padding=True,
		return_tensors="pt",
		return_attention_mask=True,
	)
	for k, v in inputs.items():
		if torch.is_tensor(v):
			inputs[k] = v.to(device)
	metrics["prep_sec"] = round(time.perf_counter() - t_prep0, 3)

	t1 = time.perf_counter()
	clock["t0"] = t1
	gen_kwargs = {}
	if streamer is not None:
		gen_kwargs["audio_streamer"] = streamer
	if stop_event is not None:
		gen_kwargs["stop_check_fn"] = stop_event.is_set
	outputs = model.generate(
		**inputs,
		max_new_tokens=None,
		cfg_scale=CFG_SCALE,
		tokenizer=processor.tokenizer,
		generation_config={"do_sample": False},
		verbose=False,
		all_prefilled_outputs=copy.deepcopy(cached),
		**gen_kwargs,
	)
	if device == "cuda":
		torch.cuda.synchronize()
	metrics["generate_sec"] = round(time.perf_counter() - t1, 3)
	if device == "cuda":
		metrics["vram_peak_generate_mb"] = round(
			torch.cuda.max_memory_allocated() / (1024 * 1024), 1
		)

	if not (getattr(outputs, "speech_outputs", None) and outputs.speech_outputs[0] is not None):
		metrics["error"] = "no_speech_outputs"
		_state("READY")
		return metrics

	audio = outputs.speech_outputs[0]
	sample_rate = 24000
	audio_samples = audio.shape[-1] if hasattr(audio, "shape") else len(audio)
	metrics["sample_rate"] = sample_rate
	metrics["audio_sec"] = round(float(audio_samples) / sample_rate, 3)
	if metrics["audio_sec"] > 0:
		metrics["rtf"] = round(metrics["generate_sec"] / metrics["audio_sec"], 3)

	cancelled = bool(stop_event is not None and stop_event.is_set())
	metrics["cancelled"] = cancelled
	metrics["pcm_chunks"] = seq["n"]
	if stream and collected:
		flat = torch.cat(collected, dim=0)
		ref = audio.detach().float().cpu().reshape(-1)
		n = min(int(flat.numel()), int(ref.numel()))
		if n > 0:
			metrics["pcm_max_abs_diff"] = round(float((flat[:n] - ref[:n]).abs().max()), 6)
		metrics["pcm_samples"] = int(flat.numel())
		metrics["ref_samples"] = int(ref.numel())
		if clock["first"] is not None:
			metrics["first_pcm_sec"] = clock["first"]

	if cancelled:
		metrics["error"] = "cancelled"
		metrics["ok"] = False
		_state("READY")
		return metrics

	if not discard_audio and out_wav:
		out_path = Path(out_wav)
		out_path.parent.mkdir(parents=True, exist_ok=True)
		processor.save_audio(audio, output_path=str(out_path))
		metrics["out_wav"] = str(out_path)
	metrics["ok"] = True
	_state("READY")
	return metrics


def _probe() -> int:
	"""Process start only. Does not import the model or touch the GPU."""
	model = MODEL_PATH / "model.safetensors"
	if not model.is_file() or not VOICE_PT.is_file():
		_emit({"op": "error", "error": "probe_files_missing", "loaded": False})
		return 4
	try:
		import importlib.metadata as metadata
		import importlib.util as util
		version = metadata.version("vibevoice")
		if not version or util.find_spec("torch") is None:
			_emit({"op": "error", "error": "probe_deps_missing", "loaded": False})
			return 4
	except Exception as exc:
		_emit({"op": "error", "error": f"probe_deps_missing:{type(exc).__name__}", "loaded": False})
		return 4
	_emit({"op": "probe", "ok": True, "loaded": False, "voice": VOICE_PT.name})
	return 0


def main() -> int:
	if os.environ.get("GENTLE_VOICE_VIBEVOICE_PROBE") == "1":
		return _probe()
	try:
		ctx, timeline = _load()
	except Exception as e:
		_emit(
			{
				"op": "error",
				"req_id": None,
				"error": f"load_failed:{type(e).__name__}: {e}",
				"traceback": traceback.format_exc(),
			}
		)
		_state("ERROR", error=str(e))
		return 1

	if os.environ.get("GENTLE_VOICE_VIBEVOICE_PROBE") == "synthesize":
		_emit({"op": "probe", "ok": True, "loaded": True, "synthesized": True, "timeline": timeline})
		return 0

	_emit(
		{
			"op": "hello",
			"ok": True,
			"ready": True,
			"device": ctx["device"],
			"dtype": ctx["dtype"],
			"model_path": str(MODEL_PATH),
			"voice_pt": str(VOICE_PT),
			"timeline": timeline,
			"streaming_mode": "batch_generate",
			"native_stream": True,
		}
	)

	synth_thread: threading.Thread | None = None
	stop_event: threading.Event | None = None

	def _join_synth() -> None:
		nonlocal synth_thread
		if synth_thread is not None:
			synth_thread.join(timeout=0.05)

	for line in sys.stdin:
		line = line.strip()
		if not line:
			continue
		try:
			msg = json.loads(line)
		except json.JSONDecodeError as e:
			_emit({"op": "error", "req_id": None, "error": f"bad_json:{e}"})
			continue
		op = msg.get("op")
		req_id = msg.get("req_id")
		if op == "ping" or op == "status":
			_emit({"op": "pong", "req_id": req_id, "state": "READY", "ready": True})
			continue
		if op == "shutdown":
			if stop_event is not None:
				stop_event.set()
			_join_synth()
			_state("STOPPING")
			_emit({"op": "bye", "req_id": req_id})
			return 0
		if op == "cancel":
			if stop_event is not None:
				stop_event.set()
			_emit({"op": "cancel_ack", "req_id": req_id})
			continue
		if op == "synth":
			if synth_thread is not None and synth_thread.is_alive():
				_emit({"op": "error", "req_id": req_id, "error": "worker_busy"})
				continue
			text = str(msg.get("text") or "")
			out_wav = str(msg.get("out_wav") or "")
			stream = bool(msg.get("stream"))
			if not text.strip() or (not stream and not out_wav):
				_emit({"op": "error", "req_id": req_id, "error": "missing_text_or_out_wav"})
				continue
			stop_event = threading.Event()
			voice_pt = str(msg.get("voice_pt") or "")

			def _run(text=text, out_wav=out_wav, req_id=req_id, stop_event=stop_event, stream=stream, voice_pt=voice_pt) -> None:
				try:
					metrics = _synth(
						ctx,
						text,
						out_wav,
						discard_audio=False,
						stop_event=stop_event,
						stream=stream,
						req_id=req_id,
						voice_pt=voice_pt,
					)
					if metrics.get("ok"):
						_emit({"op": "result", "req_id": req_id, **metrics})
					else:
						_emit(
							{
								"op": "error",
								"req_id": req_id,
								"error": metrics.get("error", "synth_failed"),
								**{k: v for k, v in metrics.items() if k != "ok"},
							}
						)
				except Exception as e:
					_state("READY")
					_emit(
						{
							"op": "error",
							"req_id": req_id,
							"error": f"{type(e).__name__}: {e}",
							"traceback": traceback.format_exc(),
						}
					)

			synth_thread = threading.Thread(target=_run, name="vv-synth", daemon=True)
			synth_thread.start()
			continue
		_emit({"op": "error", "req_id": req_id, "error": f"unknown_op:{op}"})
	if stop_event is not None:
		stop_event.set()
	_join_synth()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
