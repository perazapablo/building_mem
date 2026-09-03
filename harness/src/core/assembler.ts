// El ensamblador de contexto: arma el system prompt que ve el modelo.
//
// Regla de oro: TODO lo que emite es estable DENTRO de una fase — mismo input,
// mismos bytes. El caching de prompts es prefix-match a nivel byte; un
// timestamp, un contador de turno o un reordenamiento invalidan el cache en
// todos los providers a la vez. Lo volátil vive en messages, nunca acá.
//
// Compactación intencional: al cruzar de fase la conversación se descarta y
// el artefacto de la fase anterior (research.md, plan.md) entra al system.
// El artefacto ES el contexto compactado — por eso los gates lo validan: es
// la interfaz entre fases. (Ese descarte lo ejecuta el orquestador; acá solo
// se renderiza lo que sobrevive.)

import type { Phase, WorkflowDef } from "./workflow.js";

export interface AssembleInput {
  task: { title: string; description: string };
  workflow: WorkflowDef;
  phase: Phase;
  /** Contenido (no paths) de los artefactos heredados de fases anteriores. */
  artifacts: { research?: string; plan?: string };
  /** Render de build_context, cargado UNA vez al entrar a la fase. */
  memoryContext?: string;
}

const IDENTITY = `Eres un agente de ingeniería operando dentro de un harness con fases y gates.
Reglas que el harness hace cumplir por código (no negociables):
- Las transiciones de fase las decide el harness con gates verificables (exit codes, validación de schema). Anunciar "terminé" es una solicitud: cuando creas que la fase está completa, termina tu turno sin llamar tools y el gate decidirá.
- Solo existen las tools de esta fase. Si necesitas una que no está, no corresponde a esta fase.
- La evidencia que cuenta es verificable: exit codes, archivos, schemas. Tu narración no pasa gates.
- Si aparece una decisión real (alternativas que evaluar) usá la tool de captura disponible en esta fase; nunca la resuelvas en silencio. Jamás inventes el porqué de un descarte: un rejected_because null es un estado válido.`;

// Qué debe producir cada fase y qué va a chequear su gate — la capa soft
// alineada con la dura: el modelo que conoce el gate escribe bien a la primera.
const PHASE_CONTRACT: Record<Phase, string> = {
  exploration: `FASE: exploration — entender antes de planear.
Tu trabajo: investigar el código y el problema con las tools de lectura. NO se escribe código en esta fase.
Producto: el artefacto 'research' (write_artifact) con frontmatter YAML: goal (string), findings (lista, mínimo 1), open_questions (lista). Después del frontmatter, la prosa con el detalle.
El gate de salida valida ese frontmatter contra schema. Sin research válido no hay planning.`,

  planning: `FASE: planning — decidir el cómo antes de tocar nada.
Tu trabajo: producir el plan a partir del research heredado. NO se escribe código en esta fase.
Producto: el artefacto 'plan' (write_artifact) con frontmatter YAML: diff_scope (lista de paths/patrones que el código va a tocar — exactos, es lo que se autoriza), verification_criteria (lista de COMANDOS ejecutables que prueban que funciona, ej: "npm test"), steps (lista). Después, la prosa.
Las decisiones con alternativas reales se registran con decision_record en el momento, no al final.
El gate valida el frontmatter y un humano aprueba el plan — el diff_scope que declares es exactamente lo que vas a poder tocar.`,

  implementation: `FASE: implementation — ejecutar el plan aprobado.
Tu trabajo: implementar los steps del plan. Solo podés escribir dentro del diff_scope aprobado; write_file rechaza lo demás.
Si el plan resulta inviable o necesitás tocar fuera del scope: eso es una desviación — registrala con decision_record y decí que hace falta retroceso; NO edites el plan ni fuerces el scope.
El gate de salida exige: diff dentro del scope y build en verde (exit 0).`,

  verification: `FASE: verification — probar que funciona.
Tu trabajo: correr los verification_criteria del plan con run_command y arreglar SOLO lo necesario para que pasen (dentro del scope).
El gate de salida corre esos mismos comandos y exige exit 0 en todos. Tu lectura de la salida no cuenta; el exit code sí.`,
};

// Qué artefactos heredados ve cada fase. exploration arranca limpio;
// planning hereda el research; implementation ambos; verification el plan.
const ARTIFACTS_VISIBLE: Record<Phase, ReadonlyArray<"research" | "plan">> = {
  exploration: [],
  planning: ["research"],
  implementation: ["research", "plan"],
  verification: ["plan"],
};

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}`;
}

export function assembleSystem(input: AssembleInput): string {
  const parts: string[] = [section("Harness", IDENTITY)];

  parts.push(section("Fase actual", PHASE_CONTRACT[input.phase]));

  for (const key of ARTIFACTS_VISIBLE[input.phase]) {
    const content = input.artifacts[key];
    if (content) {
      parts.push(section(`Artefacto heredado: ${key}`, content));
    }
  }

  if (input.memoryContext) {
    parts.push(
      section(
        "Memoria del proyecto",
        `Contexto durable de sesiones anteriores. Si contradice el código actual, el código gana.\n\n${input.memoryContext}`,
      ),
    );
  }

  parts.push(
    section(
      "Tarea",
      `${input.task.title}\n\n${input.task.description}\n\nWorkflow: ${input.workflow.id}`,
    ),
  );

  return parts.join("\n\n");
}
