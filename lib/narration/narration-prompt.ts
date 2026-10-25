/**
 * System prompt for Voice AI narrator — narration only, no tools / decisions.
 */

export const NARRATION_SYSTEM_PROMPT = `Sos el adaptador de narración de Gentle Voice.

Tu ÚNICA tarea: reescribir el texto final del orquestador como una narración hablada natural, lista para síntesis de voz.

Reglas obligatorias:
- Escribí en el idioma que pide el mensaje (la voz habla sólo ese idioma). Los términos técnicos en inglés quedan como están.
- Conservá el significado, cifras, unidades, fechas, nombres, negaciones, advertencias y limitaciones.
- No inventes hechos, resultados de herramientas ni conclusiones.
- No presentes una tarea pendiente como terminada.
- No cambies cantidades ni resultados técnicos.
- No leas bloques de código, SQL, logs ni stack traces. Referí al comando o al código que ya está en pantalla.
- Resumí respuestas largas sin perder la conclusión ni las advertencias.
- Si el contenido es una credencial, una confirmación destructiva o un error que exige precisión literal, devolvés el texto casi sin cambios.
- Respondé SOLO con el texto hablado. Sin prefijos, sin comillas de envoltura, sin markdown de título, sin meta-comentarios.`;

/** The voice speaks one language, so the narration is written in it even when the source is not. */
export function buildNarrationUserMessage(sourceText: string, language?: string): string {
	if (language === "en") {
		return `Rewrite the following for speech (conversational English). Translate it if it is in another language. Stay faithful.\n\n---\n${sourceText}\n---`;
	}
	return `Reescribí lo siguiente para voz (español conversacional). Si está en otro idioma, traducilo. Conservá fidelidad.\n\n---\n${sourceText}\n---`;
}

/**
 * Skip the narrator LLM only when speaking a rewrite would be unsafe.
 * Code fences and long answers are narrated: the model is told to point at
 * the screen instead of reading the block.
 */
export function shouldPreferLiteralNarration(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	const lower = t.toLowerCase();
	if (
		/\b(rm\s+-rf|sudo\s+rm|drop\s+table|delete\s+from|format\s+c:|mkfs)\b/i.test(t)
	) {
		return true;
	}
	if (
		/\b(password|passwd|api[_-]?key|secret|token|credential|private[_-]?key)\b/i.test(
			lower,
		)
	) {
		return true;
	}
	if (/\b(confirmás|confirmas|¿estás seguro|are you sure|destructive)\b/i.test(lower)) {
		return true;
	}
	return false;
}
