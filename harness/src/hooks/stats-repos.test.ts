// stats.cjs anota en el state qué repos tocó la sesión. Es lo que usan
// session-end.cjs y stats_derivation.rs para contar commits al cerrar: sin
// eso corrían `git log` en el directorio del proceso y contaban 0 o la mitad.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const { dirDelCommit, repoDe, classify, applyMutations } = require_("../../stats.cjs") as {
  dirDelCommit: (cmd: string, cwd?: string) => string;
  repoDe: (dir: string) => string | null;
  classify: (payload: Record<string, unknown>) => Array<Record<string, unknown>>;
  applyMutations: (
    state: Record<string, unknown>,
    muts: Array<Record<string, unknown>>,
  ) => Record<string, unknown>;
};

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

describe("dirDelCommit", () => {
  it("usa el cwd del hook cuando el comando no cambia de directorio", () => {
    expect(dirDelCommit('git commit -m "x"', "/w/repo")).toBe("/w/repo");
  });

  it("respeta git -C, relativo al cwd", () => {
    expect(dirDelCommit('git -C ../otro commit -m "x"', "/w/repo")).toBe("/w/otro");
  });

  it("toma el último cd antes del commit", () => {
    const cmd = 'cd /w/front && git add -A && cd /w/back && git commit -m "x"';
    expect(dirDelCommit(cmd, "/w")).toBe("/w/back");
  });

  it("ignora un cd que viene después del commit", () => {
    expect(dirDelCommit('git commit -m "x" && cd /tmp', "/w/repo")).toBe("/w/repo");
  });

  it("acepta rutas entre comillas", () => {
    expect(dirDelCommit('cd "/w/con espacio" && git commit -m x', "/")).toBe("/w/con espacio");
  });
});

describe("repos de la sesión", () => {
  let base: string;
  let front: string;
  let back: string;

  beforeEach(async () => {
    // realpath: en algunos sistemas tmpdir es un symlink y git devuelve la ruta real.
    base = await realpath(await mkdtemp(path.join(tmpdir(), "stats-repos-")));
    front = path.join(base, "front");
    back = path.join(base, "back");
    await mkdir(path.join(front, "src"), { recursive: true });
    await mkdir(back, { recursive: true });
    gitInit(front);
    gitInit(back);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("repoDe devuelve la raíz aunque se le pase una subcarpeta", () => {
    expect(repoDe(path.join(front, "src"))).toBe(front);
  });

  it("repoDe devuelve null fuera de un repo — el caso de la carpeta padre", () => {
    expect(repoDe(base)).toBeNull();
  });

  it("repoDe sube hasta algo que exista si la carpeta todavía no existe", () => {
    expect(repoDe(path.join(front, "src", "nueva", "mas"))).toBe(front);
  });

  // El caso real del 2026-09-10: una sesión parada en la carpeta padre que
  // commitea en dos repos. Antes se guardaba 0 o 1; ahora quedan los dos.
  it("una sesión que commitea en dos repos desde la carpeta padre anota los dos", () => {
    const state: Record<string, unknown> = {};
    for (const cmd of [
      `cd ${front} && git commit -m "front"`,
      `git -C ${back} commit -m "back"`,
    ]) {
      applyMutations(state, classify({ tool_name: "Bash", tool_input: { command: cmd }, cwd: base }));
    }
    expect(state.commits).toBe(2);
    expect(state.repos).toEqual([front, back]);
  });

  it("una edición también anota su repo, y no lo duplica", async () => {
    const archivo = path.join(front, "src", "a.ts");
    await writeFile(archivo, "");
    const state: Record<string, unknown> = {};
    for (let i = 0; i < 2; i++) {
      applyMutations(state, classify({ tool_name: "Edit", tool_input: { file_path: archivo } }));
    }
    expect(state.repos).toEqual([front]);
  });
});
