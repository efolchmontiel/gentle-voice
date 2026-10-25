#!/usr/bin/env python3
"""Keep-alive Kokoro ONNX worker for Gentle Voice.

Protocol: one JSON object per line.
  stdout on start: {"op": "ready"} or {"op": "error", "error": "..."}
  stdin request:   {"id": 1, "text": "...", "voice": "ef_dora", "out": "/tmp/x.wav", "speed": 1.0}
  stdout reply:    {"op": "done", "id": 1, "sampleRate": 24000, "durationSec": 1.2}
                   {"op": "error", "id": 1, "error": "..."}
With --probe it synthesizes one short phrase and exits 0 on success.
"""

from __future__ import annotations

import argparse
import json
import sys
import wave


def emit(payload: dict) -> None:
	sys.stdout.write(json.dumps(payload) + "\n")
	sys.stdout.flush()


def write_wav(path: str, samples, rate: int) -> None:
	import numpy as np

	pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
	with wave.open(path, "wb") as out:
		out.setnchannels(1)
		out.setsampwidth(2)
		out.setframerate(rate)
		out.writeframes(pcm.tobytes())


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--model", required=True)
	parser.add_argument("--voices", required=True)
	parser.add_argument("--lang", default="es")
	parser.add_argument("--voice", default="ef_dora")
	parser.add_argument("--probe", action="store_true")
	args = parser.parse_args()

	try:
		import onnxruntime

		# fp16 graphs log one constant-folding warning per node on CPU.
		onnxruntime.set_default_logger_severity(3)
		from kokoro_onnx import Kokoro

		kokoro = Kokoro(args.model, args.voices)
	except Exception as error:  # noqa: BLE001 - reported to the host verbatim
		emit({"op": "error", "error": f"load_failed: {error}"})
		return 1

	if args.probe:
		try:
			samples, _rate = kokoro.create("Hola.", voice=args.voice, lang=args.lang)
		except Exception as error:  # noqa: BLE001
			emit({"op": "error", "error": f"probe_failed: {error}"})
			return 1
		if len(samples) == 0:
			emit({"op": "error", "error": "probe_failed: empty audio"})
			return 1
		emit({"op": "ready", "probe": True})
		return 0

	emit({"op": "ready"})
	for line in sys.stdin:
		line = line.strip()
		if not line:
			continue
		request_id = None
		try:
			request = json.loads(line)
			request_id = request.get("id")
			samples, rate = kokoro.create(
				request["text"],
				voice=request.get("voice") or args.voice,
				speed=float(request.get("speed") or 1.0),
				lang=args.lang,
			)
			write_wav(request["out"], samples, rate)
			emit({"op": "done", "id": request_id, "sampleRate": rate, "durationSec": len(samples) / rate})
		except Exception as error:  # noqa: BLE001
			emit({"op": "error", "id": request_id, "error": str(error)})
	return 0


if __name__ == "__main__":
	sys.exit(main())
