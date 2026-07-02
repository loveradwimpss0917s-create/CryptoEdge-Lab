import type { Env } from "../env.js";

export async function audit(
  env: Env,
  actor: string,
  action: string,
  entity: string,
  detail?: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(Date.now(), actor, action, entity, detail ? JSON.stringify(detail) : null)
    .run();
}
